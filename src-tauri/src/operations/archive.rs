//! Owned archive subprocess, staged publication, and one ledger effect per archive.
use super::*;
use std::{
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
impl FileExecutor {
    pub(super) fn execute_zip(
        &self,
        r: &OperationRequest,
        c: &OperationContext,
    ) -> ExecutionResult {
        let groups: Vec<Vec<&OperationItem>> = if r.options.separate {
            r.items.iter().map(|i| vec![i]).collect()
        } else {
            vec![r.items.iter().collect()]
        };
        let mut effects = vec![];
        for items in groups {
            if items.is_empty() || c.is_cancelled() {
                break;
            }
            let mut out = ItemOutcome::new(&items[0].item_id, OutcomeStatus::Failed);
            out.source = items[0].source.clone();
            let paths = r.destination.iter().map(PathBuf::from).collect::<Vec<_>>();
            let (ancestors, result) = match self.capture_ancestor_receipts(&paths, c) {
                Ok(receipts) => (receipts, self.archive_group(r, &items, c, &mut out)),
                Err(err) => (vec![], Err(err)),
            };
            match result {
                Ok(Some(mut e)) => {
                    e.ancestor_receipts = ancestors;
                    self.apply_forward_receipts(&e, &out, c);
                    out.effect_id = Some(e.id.clone());
                    effects.push(e);
                }
                Ok(None) => {}
                Err(e) => {
                    if out.status != OutcomeStatus::Partial {
                        out.status = if c.is_cancelled() {
                            OutcomeStatus::Cancelled
                        } else {
                            OutcomeStatus::Failed
                        };
                    }
                    out.error = Some(error(&e, Phase::Archiving));
                    out.retry = RetryKind::RetryItem;
                }
            }
            c.record_outcome(out.clone());
            for item in items.iter().skip(1) {
                let mut companion = out.clone();
                companion.item_id = item.item_id.clone();
                companion.source = item.source.clone();
                companion.effect_id = None;
                companion.published = false;
                c.record_outcome(companion);
            }
        }
        self.remember(effects)
    }
    fn archive_group(
        &self,
        r: &OperationRequest,
        items: &[&OperationItem],
        c: &OperationContext,
        out: &mut ItemOutcome,
    ) -> io::Result<Option<Effect>> {
        let parent = PathBuf::from(
            r.destination
                .as_ref()
                .ok_or_else(|| invalid("压缩目标目录缺失"))?,
        );
        if !parent.is_absolute() || !parent.is_dir() {
            return Err(invalid("目标必须为存在的绝对目录"));
        }
        let sources = items
            .iter()
            .map(|i| {
                i.source
                    .as_ref()
                    .map(PathBuf::from)
                    .ok_or_else(|| invalid("压缩源路径缺失"))
            })
            .collect::<io::Result<Vec<_>>>()?;
        for source in &sources {
            if !source.is_absolute() {
                return Err(invalid("压缩源必须为绝对路径"));
            }
            ensure_outside(source, &parent)?;
        }
        let name = if r.options.separate {
            format!("{}.zip", basename(&sources[0])?)
        } else if let Some(name) = &r.options.archive_name {
            if name.to_lowercase().ends_with(".zip") {
                name.clone()
            } else {
                format!("{name}.zip")
            }
        } else if sources.len() == 1 {
            format!("{}.zip", basename(&sources[0])?)
        } else {
            "归档.zip".into()
        };
        valid_name(&name)?;
        let requested = parent.join(name);
        out.requested_destination = Some(display(&requested));
        let (mut dest, replacement) = match self.choose_destination(
            None,
            &requested,
            items[0],
            c,
            r.options.keep_both,
            false,
        )? {
            Choice::Skip => {
                out.status = OutcomeStatus::Skipped;
                return Ok(None);
            }
            Choice::Target(d, m) => (d, m),
        };
        c.set_phase(Phase::Scanning, Cancelability::Checkpoint);
        let guards = sources
            .iter()
            .map(|s| Manifest::capture(s, &|| checkpoint(c)))
            .collect::<io::Result<Vec<_>>>()?;
        let mut record = Record::new(None, dest.clone());
        let root = OwnedRoot::create(&parent)?;
        record.roots.push(root.clone());
        let archive = root.path.join("archive.zip");
        record.incoming = Some(archive.clone());
        if let Err(e) = self.save(&record, c) {
            let _ = root.cleanup();
            return Err(e);
        }
        let result = (|| {
            let mut cmd = Command::new("zip");
            cmd.args(["-r", "-q"]).arg(format!(
                "-{}",
                r.options.compression_level.unwrap_or(1).min(9)
            ));
            cmd.stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null());
            if let Some(password) = r.options.password.as_deref().filter(|p| !p.is_empty()) {
                cmd.arg("-P").arg(password);
            }
            let common = sources[0]
                .parent()
                .filter(|p| sources.iter().all(|s| s.parent() == Some(*p)));
            let mut names = vec![];
            if let Some(common) = common {
                cmd.arg("-y").current_dir(common);
                for s in &sources {
                    names.push(format!("./{}", basename(s)?));
                }
            } else {
                let input = root.path.join("inputs");
                crate::create_private_dir(&input)?;
                for s in &sources {
                    let link = crate::unique_path(&input, &basename(s)?);
                    std::os::unix::fs::symlink(s, &link)?;
                    names.push(format!("./{}", basename(&link)?));
                }
                cmd.current_dir(input);
            }
            cmd.arg(&archive).args(&names).args(["-x", "*.DS_Store"]);
            checkpoint(c)?;
            c.set_phase(Phase::Archiving, Cancelability::Checkpoint);
            let mut child = OwnedChild(
                cmd.spawn()
                    .map_err(|_| io::Error::other("无法启动 zip 压缩进程"))?,
            );
            #[cfg(test)]
            self.child_ids.lock().unwrap().push(child.0.id());
            self.at(Point::ArchiveSpawned, &archive, c)?;
            loop {
                if c.is_cancelled() {
                    let _ = child.0.kill();
                    let _ = child.0.wait();
                    return Err(cancelled());
                }
                match child.0.try_wait()? {
                    Some(status) => {
                        if !status.success() {
                            return Err(io::Error::other(format!(
                                "压缩进程失败（退出码 {}）",
                                status.code().unwrap_or(-1)
                            )));
                        }
                        break;
                    }
                    None => thread::sleep(Duration::from_millis(25)),
                }
            }
            for (source, guard) in sources.iter().zip(&guards) {
                if self.scan_manifest(source, c, Point::SourceVerify)? != *guard {
                    return Err(identity::changed());
                }
            }
            let manifest = self.scan_manifest(&archive, c, Point::PreparedVerify)?;
            record.incoming_manifest = Some(manifest);
            record.phase = "archivePrepared".into();
            self.save(&record, c)?;
            checkpoint(c)?;
            self.at(Point::BeforePublish, &dest, c)?;
            checkpoint(c)?;
            c.set_phase(Phase::Publishing, Cancelability::Finishing);
            if let Some(old) = replacement {
                self.capture_backup(&mut record, &old, c)?;
            }
            let published = self.publish_incoming(
                &mut record,
                None,
                &requested,
                items[0],
                c,
                r.options.keep_both,
                false,
            )?;
            dest = record.destination.clone();
            Ok(published)
        })();
        match result {
            Err(e) => return self.retained_failure(&record, items[0], out, e),
            Ok(false) => {
                self.abandon(&record);
                out.status = OutcomeStatus::Skipped;
                return Ok(None);
            }
            Ok(true) => {}
        }
        out.published = true;
        out.actual_destination = Some(display(&dest));
        out.affected_directories = affected(None, &dest);
        let expected = record.incoming_manifest.clone().unwrap();
        let manifest = match self
            .at(Point::PublishedVerify, &dest, c)
            .and_then(|_| Manifest::capture(&dest, &|| Ok(())))
        {
            Ok(m) if expected.same_captured_manifest(&m) => m,
            other => {
                return Ok(Some(self.published_failure(
                    &mut record,
                    &items[0].item_id,
                    out,
                    EffectKind::Created,
                    expected,
                    other.err().unwrap_or_else(identity::changed),
                )))
            }
        };
        record.destination_manifest = Some(manifest.clone());
        record.phase = "published".into();
        let mut effect = Effect::new(
            items[0].item_id.clone(),
            EffectKind::Created,
            None,
            dest.clone(),
            manifest,
            record.id.clone(),
        );
        effect.backup = record.protected.first().cloned();
        if let Err(e) = self
            .save(&record, c)
            .and_then(|_| self.at(Point::AfterPublish, &dest, c))
        {
            out.status = OutcomeStatus::Partial;
            out.retry = RetryKind::ManualRecovery;
            out.error = Some(error(&e, Phase::Publishing));
            let _ = self.journal.save(&record);
        } else {
            out.status = OutcomeStatus::Succeeded;
            self.finish_record(&record);
        }
        Ok(Some(effect))
    }
}
