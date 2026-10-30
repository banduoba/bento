// 探针 2：真实数据跑 内容搜索 + 内容预览，定位崩溃
use std::sync::OnceLock;
static FSEARCH: OnceLock<Option<fsearch::Engine>> = OnceLock::new();

fn fsearch_engine() -> Option<&'static fsearch::Engine> {
    FSEARCH
        .get_or_init(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            match fsearch::Engine::start(fsearch::Options {
                dir: fsearch::default_dir(&home),
                home: home.clone(),
                skip: None,
            }) {
                Ok(e) => Some(e),
                Err(err) => { eprintln!("fsearch init failed: {err}"); None }
            }
        })
        .as_ref()
}

fn main() {
    let q = std::env::args().nth(1).unwrap_or_else(|| "测试".into());
    let home = std::env::var("HOME").unwrap_or_default();
    let Some(eng) = fsearch_engine() else { return };
    let st = eng.status();
    println!("status: ready={} entries={} fda={}", st.ready, st.entries, st.full_disk_access);

    // 1. 内容搜索（grep）
    let query = fsearch::Query::parse(&format!("grep:{}", q), &home).unwrap();
    let g = fsearch::Grep::new(&q, fsearch::GrepMode::Literal).unwrap();
    println!("grep 搜索中…");
    let t0 = std::time::Instant::now();
    match eng.grep(&query, &g) {
        Ok((res, _)) => {
            println!("grep OK: {} files, {} ms", res.files.len(), t0.elapsed().as_millis());
            if let Some(f) = res.files.first() {
                let p = std::path::PathBuf::from(String::from_utf8_lossy(&f.path).into_owned());
                println!("首个结果: {}", p.display());
                let bytes = std::fs::read(&p).unwrap_or_default();
                println!("读取 OK: {} bytes", bytes.len());
                let probe = &bytes[..bytes.len().min(8192)];
                println!("含 NUL: {}", probe.contains(&0u8));
                let full = String::from_utf8_lossy(&bytes).into_owned();
                let text: String = full
                    .lines()
                    .take(3000)
                    .map(|l| {
                        if l.chars().count() > 300 {
                            let t: String = l.chars().take(300).collect();
                            format!("{} …", t)
                        } else {
                            l.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                println!("行截断 OK: {} chars, {} lines", text.chars().count(), text.lines().count());
            }
        }
        Err(e) => println!("grep Err: {e}"),
    }
}
