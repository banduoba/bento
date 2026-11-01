//! Read-only, bounded filename transformation. No paths or filesystem operations.
use regex::{Captures, RegexBuilder};

const TEXT_LIMIT: usize = 4096;

fn append(out: &mut String, text: &str) -> Result<(), String> {
    if text.len() > TEXT_LIMIT - out.len() {
        return Err("正则替换后的名称过长（最多4096字节）".into());
    }
    out.push_str(text);
    Ok(())
}

// Stream regex's $name/${name}/$1/$$ syntax into the bounded destination.
// Captures::expand builds an unbounded intermediate string for repeated captures.
fn expand(out: &mut String, caps: &Captures<'_>, mut template: &str) -> Result<(), String> {
    while let Some(dollar) = template.find('$') {
        append(out, &template[..dollar])?;
        template = &template[dollar + 1..];
        if let Some(rest) = template.strip_prefix('$') {
            append(out, "$")?;
            template = rest;
            continue;
        }
        let reference = if let Some(braced) = template.strip_prefix('{') {
            braced.find('}').map(|end| (&braced[..end], end + 2))
        } else {
            let end = template
                .bytes()
                .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
                .count();
            (end > 0).then_some((&template[..end], end))
        };
        if let Some((name, end)) = reference {
            let matched = match name.parse::<usize>() {
                Ok(index) => caps.get(index),
                Err(_) => caps.name(name),
            };
            if let Some(matched) = matched {
                append(out, matched.as_str())?;
            }
            template = &template[end..];
        } else {
            append(out, "$")?;
        }
    }
    append(out, template)
}

pub fn replace_names(
    names: &[String],
    pattern: &str,
    replacement: &str,
) -> Result<Vec<String>, String> {
    if pattern.len() > TEXT_LIMIT {
        return Err("正则表达式过长（最多4096字节）".into());
    }
    if replacement.len() > TEXT_LIMIT {
        return Err("替换文本过长（最多4096字节）".into());
    }
    let regex = RegexBuilder::new(pattern)
        .size_limit(1024 * 1024)
        .build()
        .map_err(|error| format!("正则表达式无效或编译后过长：{error}"))?;
    names
        .iter()
        .map(|name| {
            let mut out = String::new();
            let mut last = 0;
            for caps in regex.captures_iter(name) {
                let matched = caps.get(0).expect("regex always provides the full match");
                append(&mut out, &name[last..matched.start()])?;
                expand(&mut out, &caps, replacement)?;
                last = matched.end();
            }
            append(&mut out, &name[last..])?;
            Ok(out)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(names: &[&str], pattern: &str, replacement: &str) -> Result<Vec<String>, String> {
        replace_names(
            &names.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            pattern,
            replacement,
        )
    }
    #[test]
    fn captures_and_all_matches() {
        assert_eq!(
            run(&["sample_12", "sample_3"], r"^sample_(\d+)$", "case_$1").unwrap(),
            ["case_12", "case_3"]
        );
        assert_eq!(run(&["a1a2"], r"a(?P<n>\d)", "${n}!").unwrap(), ["1!2!"]);
        assert_eq!(run(&["ababa"], "a", "_").unwrap(), ["_b_b_"]);
    }
    #[test]
    fn replacement_template_matches_regex_semantics() {
        let pattern = r"(?P<word>abc)(?P<数字>文)?";
        let names = ["abc文", "abc"];
        let cases = [
            (
                "$$:$0:${word}:$2:${数字}",
                ["$:abc文:abc:文:文", "$:abc:abc::"],
            ),
            ("$missing/${missing}/$99", ["//", "//"]),
            ("$1x:${1}x:$01", [":abcx:abc", ":abcx:abc"]),
            ("$-${unclosed-$", ["$-${unclosed-$", "$-${unclosed-$"]),
        ];
        let regex = regex::Regex::new(pattern).unwrap();
        for (template, expected) in cases {
            let actual = run(&names, pattern, template).unwrap();
            assert_eq!(actual, expected);
            for (name, output) in names.iter().zip(&actual) {
                assert_eq!(output, &regex.replace_all(name, template));
            }
        }
    }
    #[test]
    fn no_match_unicode_flags_and_empty_pattern() {
        assert_eq!(
            run(&["中文_é", "unchanged"], r"\p{Han}+", "文").unwrap(),
            ["文_é", "unchanged"]
        );
        assert_eq!(run(&["AbA"], "(?i)a", "x").unwrap(), ["xbx"]);
        assert_eq!(run(&["é"], "", "_").unwrap(), ["_é_"]);
        assert!(run(&[], "a", "b").unwrap().is_empty());
    }
    #[test]
    fn invalid_and_unsupported_syntax_errors() {
        for pattern in ["[", "(?=x)", r"(a)\1"] {
            assert!(run(&["a"], pattern, "").unwrap_err().contains("正则"));
        }
    }
    #[test]
    fn limits_pattern_replacement_and_compiled_size() {
        assert!(run(&["a"], &"a".repeat(4097), "")
            .unwrap_err()
            .contains("过长"));
        assert!(run(&["a"], "a", &"文".repeat(1366))
            .unwrap_err()
            .contains("过长"));
        assert!(run(&["a"], r"\w{1000}", "").unwrap_err().contains("正则"));
        assert_eq!(run(&["a"], "a", &"x".repeat(4096)).unwrap()[0].len(), 4096);
    }
    #[test]
    fn bounds_expanded_and_unmatched_outputs() {
        assert!(run(&["aa"], "a", &"x".repeat(4096))
            .unwrap_err()
            .contains("过长"));
        assert!(run(&[&"a".repeat(4097)], "z", "")
            .unwrap_err()
            .contains("过长"));
        assert!(run(&[&"a".repeat(4096)], "a", "$0$0")
            .unwrap_err()
            .contains("过长"));
        assert_eq!(run(&[&"文".repeat(1365)], "z", "").unwrap()[0].len(), 4095);
    }
}
