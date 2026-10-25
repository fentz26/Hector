//! Ranked file search for Hector: a port of `HT.fuzzy` (src/content/tree.js),
//! built to match it result for result. A persistent index keeps every path
//! lowercased inside the module, so a keystroke only passes the query in.
//!
//! Raw C ABI, no glue code and no dependencies:
//!   alloc(len) -> ptr          dealloc(ptr, len)
//!   load(ptr, len) -> handle   paths separated by '\n' (UTF-8) -> a new index
//!   free(handle)               drop an index
//!   search(handle, ptr, len, limit)
//!                              query (UTF-8, as typed) -> number of u32 words in the result
//!   out_ptr() -> ptr           the result: [total, k, (path index, n, n x match index) x k]
//! Match indices are UTF-16 offsets into the lowercased path, like the JS ones.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::HashMap;

#[derive(Default)]
struct Index {
    /// All paths, lowercased, back to back. ASCII paths are matched on these bytes.
    text: Vec<u8>,
    /// (start, end) of each path in `text`.
    spans: Vec<(u32, u32)>,
    /// UTF-16 form of the paths that are not pure ASCII (matched on code units),
    /// by path number; most repositories have none.
    wide: std::collections::HashMap<u32, Vec<u16>>,
}

thread_local! {
    static INDEXES: RefCell<(u32, HashMap<u32, Index>)> = RefCell::new((0, HashMap::new()));
    static OUT: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from a matching `alloc` call.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// # Safety
/// `ptr..ptr+len` must be readable memory holding UTF-8.
#[no_mangle]
pub unsafe extern "C" fn load(ptr: *const u8, len: usize) -> u32 {
    let joined = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("");
    let mut index = Index::default();
    for path in joined.split('\n') {
        let lower = path.to_lowercase();
        let start = index.text.len() as u32;
        index.text.extend_from_slice(lower.as_bytes());
        index.spans.push((start, index.text.len() as u32));
        if !lower.is_ascii() {
            let n = index.spans.len() as u32 - 1;
            index.wide.insert(n, lower.encode_utf16().collect());
        }
    }
    INDEXES.with(|i| {
        let mut all = i.borrow_mut();
        all.0 += 1;
        let handle = all.0;
        all.1.insert(handle, index);
        handle
    })
}

#[no_mangle]
pub extern "C" fn free(handle: u32) {
    INDEXES.with(|i| {
        i.borrow_mut().1.remove(&handle);
    });
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u32 {
    OUT.with(|o| o.borrow().as_ptr())
}

/// # Safety
/// `ptr..ptr+len` must be readable memory holding UTF-8.
#[no_mangle]
pub unsafe extern "C" fn search(handle: u32, ptr: *const u8, len: usize, limit: usize) -> usize {
    let query = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("").to_lowercase();
    let q16: Vec<u16> = query.encode_utf16().collect();
    let q8: Option<&[u8]> = query.is_ascii().then(|| query.as_bytes());
    // The query's code points, split once rather than for every path.
    let cp8: Vec<&[u8]> = q8.map(code_points).unwrap_or_default();
    let cp16: Vec<&[u16]> = code_points(&q16);

    let mut hits: Vec<(f64, u32)> = Vec::new();
    INDEXES.with(|i| {
        let all = i.borrow();
        let Some(idx) = all.1.get(&handle) else { return };
        let has_wide = !idx.wide.is_empty();
        for (n, &(s, e)) in idx.spans.iter().enumerate() {
            let score = if has_wide && idx.wide.contains_key(&(n as u32)) {
                score(&q16, &cp16, &idx.wide[&(n as u32)])
            } else {
                q8.and_then(|q| score(q, &cp8, &idx.text[s as usize..e as usize]))
            };
            if let Some(sc) = score {
                hits.push((sc, n as u32));
            }
        }
    });

    // Best first; ties keep the original order (what a stable sort gives in JS).
    let by_rank = |a: &(f64, u32), b: &(f64, u32)| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal).then(a.1.cmp(&b.1));
    let total = hits.len();
    let k = limit.min(total);
    if k > 0 && k < total {
        hits.select_nth_unstable_by(k - 1, by_rank);
        hits.truncate(k);
    }
    hits.sort_by(by_rank);

    OUT.with(|o| {
        let mut out = o.borrow_mut();
        out.clear();
        out.push(total as u32);
        out.push(hits.len() as u32);
        INDEXES.with(|i| {
            let all = i.borrow();
            let Some(idx) = all.1.get(&handle) else { return };
            for &(_, n) in &hits {
                let (s, e) = idx.spans[n as usize];
                let at = match idx.wide.get(&n) {
                    None => q8.map(|q| indices(q, &cp8, &idx.text[s as usize..e as usize])).unwrap_or_default(),
                    Some(t) => indices(&q16, &cp16, t),
                };
                out.push(n);
                out.push(at.len() as u32);
                out.extend(at);
            }
        });
        out.len()
    })
}

// ---- the matcher: HT.fuzzy on code units (u8 for ASCII paths, u16 otherwise) ----

trait Unit: Copy + PartialEq + Into<u32> {}
impl Unit for u8 {}
impl Unit for u16 {}

fn find<T: Unit>(t: &[T], from: usize, needle: &[T]) -> Option<usize> {
    if needle.is_empty() {
        return (from <= t.len()).then_some(from);
    }
    if from >= t.len() || t.len() - from < needle.len() {
        return None;
    }
    let first = needle[0];
    if needle.len() == 1 {
        return t[from..].iter().position(|&c| c == first).map(|i| i + from);
    }
    (from..=t.len() - needle.len()).find(|&i| t[i] == first && t[i..i + needle.len()] == *needle)
}

fn rfind_slash<T: Unit>(t: &[T]) -> usize {
    t.iter().rposition(|&c| c.into() == b'/' as u32).map_or(0, |i| i + 1)
}

/// Code points of the query, as unit slices (surrogate pairs stay together).
fn code_points<T: Unit>(q: &[T]) -> Vec<&[T]> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < q.len() {
        let u: u32 = q[i].into();
        let step = if (0xD800..0xDC00).contains(&u) && i + 1 < q.len() && (0xDC00..0xE000).contains(&q[i + 1].into()) { 2 } else { 1 };
        out.push(&q[i..i + step]);
        i += step;
    }
    out
}

fn is_boundary(c: u32) -> bool {
    matches!(c, 0x2F | 0x2D | 0x5F | 0x2E | 0x20) // / - _ . space
}

/// Contiguous match first (preferring the file name), else a subsequence.
fn score<T: Unit>(q: &[T], cps: &[&[T]], t: &[T]) -> Option<f64> {
    if q.is_empty() {
        return None;
    }
    let name_start = rfind_slash(t);
    let sub = find(t, name_start, q).or_else(|| find(t, 0, q));
    if let Some(sub) = sub {
        let name_len = (t.len() - name_start) as f64;
        return Some(
            1000.0 + if sub >= name_start { 500.0 } else { 0.0 } + if sub == name_start { 200.0 } else { 0.0 } - name_len - name_start as f64 * 0.05,
        );
    }
    let mut ti = 0usize;
    let mut sc = 0.0f64;
    let mut prev: i64 = -2;
    for &ch in cps {
        if ch.len() == 1 && ch[0].into() == 0x20 {
            continue;
        }
        let found = find(t, ti, ch)?;
        let boundary = found == 0 || is_boundary(t[found - 1].into());
        sc += 10.0 + if found as i64 == prev + 1 { 15.0 } else { 0.0 } + if boundary { 12.0 } else { 0.0 } + if found >= name_start { 8.0 } else { 0.0 };
        prev = found as i64;
        ti = found + 1;
    }
    Some(sc - t.len() as f64 * 0.1)
}

/// The match positions that `score` found (for highlighting).
fn indices<T: Unit>(q: &[T], cps: &[&[T]], t: &[T]) -> Vec<u32> {
    let name_start = rfind_slash(t);
    if let Some(sub) = find(t, name_start, q).or_else(|| find(t, 0, q)) {
        return (sub..sub + q.len()).map(|i| i as u32).collect();
    }
    let mut out = Vec::new();
    let mut ti = 0usize;
    for &ch in cps {
        if ch.len() == 1 && ch[0].into() == 0x20 {
            continue;
        }
        match find(t, ti, ch) {
            Some(found) => {
                out.push(found as u32);
                ti = found + 1;
            }
            None => return Vec::new(),
        }
    }
    out
}
