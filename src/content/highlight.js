// Code colors for the file and diff preview. One small tokenizer driven by
// per-language profiles (comments, strings, keywords, types), not a parser:
// it colors comments, strings, numbers, keywords, types, calls, attributes
// and keys the way GitHub and GitLab do, for the common languages, and stays
// plain for the rest. Lines are colored in order, so a comment or string
// that spans lines keeps its color.
HT.highlight = (() => {
  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

  const C_LIKE = {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"'],
    char: true,
    constants: words('true false null NULL nullptr'),
  };
  const LANGS = {
    rust: {
      ...C_LIKE,
      keywords: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while yield'),
      types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Some None Ok Err'),
      constants: words('true false None'),
      attrs: /#!?\[[^\]]*\]?/y,
      macros: true,
      lifetimes: true,
    },
    js: {
      ...C_LIKE,
      quotes: ['"', "'"],
      multi: ['`'],
      char: false,
      keywords: words('async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield as interface type enum implements private protected public readonly declare namespace abstract keyof satisfies'),
      types: words('string number boolean any unknown never object symbol bigint void Promise Array Map Set Record'),
      constants: words('true false null undefined NaN Infinity'),
      decorators: true,
    },
    py: {
      line: ['#'],
      block: [['"""', '"""'], ["'''", "'''"]],
      blockIsString: true,
      quotes: ['"', "'"],
      keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'),
      types: words('int float str bool list dict set tuple bytes object type self cls'),
      constants: words('True False None'),
      decorators: true,
    },
    go: {
      ...C_LIKE,
      multi: ['`'],
      keywords: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
      types: words('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any'),
      constants: words('true false nil iota'),
    },
    c: {
      ...C_LIKE,
      keywords: words('auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while class namespace template typename public private protected virtual override final new delete operator using friend explicit constexpr noexcept this throw try catch'),
      types: words('void char short int long float double signed unsigned bool size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t auto std string vector'),
      preprocessor: true,
    },
    java: {
      ...C_LIKE,
      keywords: words('abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield fun val when object companion data inline suspend override open internal lateinit'),
      types: words('boolean byte char double float int long short void String Object Integer List Map Unit Int Long Boolean'),
      decorators: true,
    },
    cs: {
      ...C_LIKE,
      keywords: words('abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while async await var get set init record'),
      types: words('bool byte char decimal double float int long object sbyte short string uint ulong ushort void dynamic'),
      preprocessor: true,
    },
    swift: {
      ...C_LIKE,
      keywords: words('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is rethrows super self Self throw throws try async await some any'),
      types: words('Int Double Float String Bool Character Array Dictionary Set Optional Void'),
      constants: words('true false nil'),
      decorators: true,
    },
    rb: {
      line: ['#'],
      block: [['=begin', '=end']],
      quotes: ['"', "'"],
      keywords: words('alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_reader attr_writer attr_accessor private protected public'),
      constants: words('true false nil'),
      symbols: true,
    },
    php: {
      ...C_LIKE,
      line: ['//', '#'],
      quotes: ['"', "'"],
      char: false,
      keywords: words('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'),
      constants: words('true false null TRUE FALSE NULL'),
      variables: /\$[A-Za-z_]\w*/y,
    },
    sh: {
      line: ['#'],
      quotes: ['"', "'"],
      keywords: words('if then else elif fi case esac for select while until do done in function time return exit export local readonly declare unset set shift source alias'),
      builtins: words('echo printf cd pwd test read eval exec trap cat grep sed awk find xargs mkdir rm cp mv chmod chown curl git npm node cargo make docker'),
      constants: words('true false'),
      variables: /\$(\{[^}]*\}|[A-Za-z_]\w*|[0-9@#?$!*-])/y,
    },
    sql: {
      line: ['--'],
      block: [['/*', '*/']],
      quotes: ["'", '"'],
      caseless: true,
      keywords: words('select from where and or not insert into values update set delete create table alter drop index view join left right inner outer full on as group by order having limit offset union all distinct case when then else end is null like in between exists primary key foreign references default constraint unique returning with begin commit rollback transaction'),
      types: words('int integer bigint smallint text varchar char boolean date timestamp timestamptz numeric decimal real float serial uuid json jsonb'),
      constants: words('true false null'),
    },
    lua: {
      line: ['--'],
      block: [['--[[', ']]']],
      quotes: ['"', "'"],
      keywords: words('and break do else elseif end for function goto if in local not or repeat return then until while'),
      constants: words('true false nil'),
    },
    hs: {
      line: ['--'],
      block: [['{-', '-}']],
      quotes: ['"'],
      keywords: words('case class data default deriving do else if import in infix infixl infixr instance let module newtype of then type where'),
    },
    yaml: { line: ['#'], quotes: ['"', "'"], constants: words('true false null yes no on off ~'), keys: /[A-Za-z0-9_.\-/"' ]+(?=\s*:(\s|$))/y },
    toml: { line: ['#'], quotes: ['"', "'"], multiQuote: true, constants: words('true false'), keys: /[A-Za-z0-9_.\-"']+(?=\s*=)/y, sections: true },
    ini: { line: [';', '#'], quotes: ['"'], keys: /[A-Za-z0-9_.\-]+(?=\s*=)/y, sections: true },
    json: { line: [], quotes: ['"'], constants: words('true false null'), jsonKeys: true },
    css: { block: [['/*', '*/']], line: [], quotes: ['"', "'"], css: true },
    markup: { markup: true },
    md: { markdown: true },
    make: { line: ['#'], quotes: ['"', "'"], variables: /\$[({][^)}]*[)}]|\$[@<^*?]/y, targets: true, keywords: words('ifeq ifneq ifdef ifndef else endif include define endef export override') },
    docker: { line: ['#'], quotes: ['"', "'"], caseless: true, keywords: words('from as run cmd label expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell'), variables: /\$(\{[^}]*\}|[A-Za-z_]\w*)/y },
  };
  LANGS.kt = LANGS.java;
  LANGS.scala = LANGS.java;
  LANGS.dart = { ...LANGS.java, quotes: ['"', "'"], char: false };
  LANGS.zig = { ...LANGS.c, keywords: words('const var fn pub return if else while for switch break continue defer errdefer try catch struct enum union error comptime inline export extern test unreachable orelse and or') };
  LANGS.proto = { ...C_LIKE, keywords: words('syntax package import option message enum service rpc returns repeated optional required oneof map reserved extend'), types: words('int32 int64 uint32 uint64 sint32 sint64 fixed32 fixed64 bool string bytes double float') };
  LANGS.gql = { line: ['#'], quotes: ['"'], keywords: words('query mutation subscription fragment on type interface union enum input scalar schema extend implements directive'), types: words('ID String Int Float Boolean') };
  LANGS.ps = { line: ['#'], block: [['<#', '#>']], quotes: ['"', "'"], caseless: true, keywords: words('begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while'), variables: /\$[A-Za-z_][\w:]*/y };
  LANGS.r = { line: ['#'], quotes: ['"', "'"], keywords: words('if else repeat while function for in next break library require return'), constants: words('TRUE FALSE NULL NA Inf NaN') };
  LANGS.ex = { line: ['#'], quotes: ['"', "'"], keywords: words('def defp defmodule defmacro do end fn if else unless case cond with when import alias require use quote unquote receive try rescue after'), constants: words('true false nil'), symbols: true };

  const EXT = {
    rs: 'rust', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'markup', svelte: 'markup',
    py: 'py', pyi: 'py', pyw: 'py', go: 'go', c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', m: 'c', mm: 'c', ino: 'c',
    cu: 'c', glsl: 'c', hlsl: 'c', wgsl: 'rust', metal: 'c', vert: 'c', frag: 'c', comp: 'c', shader: 'c', usf: 'c', ush: 'c',
    java: 'java', kt: 'kt', kts: 'kt', scala: 'scala', groovy: 'java', gradle: 'java', cs: 'cs', fs: 'cs', swift: 'swift', dart: 'dart', zig: 'zig',
    rb: 'rb', rake: 'rb', gemspec: 'rb', php: 'php', sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ksh: 'sh', envrc: 'sh', ps1: 'ps', psm1: 'ps',
    sql: 'sql', lua: 'lua', hs: 'hs', r: 'r', ex: 'ex', exs: 'ex', proto: 'proto', graphql: 'gql', gql: 'gql',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini', editorconfig: 'ini', gitconfig: 'ini',
    json: 'json', jsonc: 'js', json5: 'js', jsonl: 'json', ipynb: 'json', lock: 'json',
    css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', xaml: 'markup', plist: 'markup', csproj: 'markup', props: 'markup', targets: 'markup', vcxproj: 'markup', uproject: 'json', uplugin: 'json',
    md: 'md', mdx: 'md', markdown: 'md', mk: 'make', cmake: 'sh', nix: 'sh', tf: 'sh', hcl: 'sh',
  };
  const NAMES = {
    dockerfile: 'docker', containerfile: 'docker', makefile: 'make', gnumakefile: 'make', 'cmakelists.txt': 'sh', gemfile: 'rb', rakefile: 'rb',
    'cargo.lock': 'toml', 'pipfile': 'toml', '.gitignore': 'sh', '.dockerignore': 'sh', '.gitattributes': 'sh', '.bashrc': 'sh', '.zshrc': 'sh', '.profile': 'sh',
    jenkinsfile: 'java', vagrantfile: 'rb', brewfile: 'rb', justfile: 'make', 'build.bazel': 'py', build: 'py', workspace: 'py',
  };

  function forFile(name) {
    const lower = String(name || '').toLowerCase();
    if (NAMES[lower]) return LANGS[NAMES[lower]];
    if (lower.startsWith('dockerfile')) return LANGS.docker;
    const dot = lower.lastIndexOf('.');
    const ext = dot >= 0 ? lower.slice(dot + 1) : '';
    return LANGS[EXT[ext]] || null;
  }

  const NUM = /(0x[0-9a-f_]+|0b[01_]+|0o[0-7_]+|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(e[+-]?\d+)?)([a-z]\w*)?/iy;
  const IDENT = /[A-Za-z_$][\w$]*[?!]?/y;
  const at = (re, text, i) => {
    re.lastIndex = i;
    const m = re.exec(text);
    return m ? m[0] : null;
  };

  // Markup (HTML/XML/Vue): comments, tags, attribute names and values.
  function markupLine(text, state, out) {
    let i = 0;
    while (i < text.length) {
      if (state.block) {
        const end = text.indexOf('-->', i);
        const stop = end < 0 ? text.length : end + 3;
        out.push(['com', text.slice(i, stop)]);
        if (end >= 0) state.block = null;
        i = stop;
        continue;
      }
      if (text.startsWith('<!--', i)) {
        state.block = 'comment';
        continue;
      }
      if (state.inTag) {
        const ws = at(/\s+/y, text, i);
        if (ws) {
          out.push([null, ws]);
          i += ws.length;
          continue;
        }
        if (text[i] === '>' || text.startsWith('/>', i)) {
          const t = text[i] === '>' ? '>' : '/>';
          out.push(['punct', t]);
          i += t.length;
          state.inTag = false;
          continue;
        }
        if (text[i] === '"' || text[i] === "'") {
          const end = text.indexOf(text[i], i + 1);
          const stop = end < 0 ? text.length : end + 1;
          out.push(['str', text.slice(i, stop)]);
          i = stop;
          continue;
        }
        const attr = at(/[^\s=>/"']+/y, text, i);
        if (attr) {
          out.push(['attr', attr]);
          i += attr.length;
          continue;
        }
        out.push([null, text[i++]]);
        continue;
      }
      const tag = at(/<\/?[A-Za-z][\w:.-]*/y, text, i);
      if (tag) {
        out.push(['punct', tag[1] === '/' ? '</' : '<'], ['tag', tag.slice(tag[1] === '/' ? 2 : 1)]);
        i += tag.length;
        state.inTag = true;
        continue;
      }
      const ent = at(/&[#\w]+;/y, text, i);
      if (ent) {
        out.push(['const', ent]);
        i += ent.length;
        continue;
      }
      const plain = at(/[^<&]+/y, text, i) || text[i];
      out.push([null, plain]);
      i += plain.length;
    }
  }

  // Markdown: headings, quotes, list marks, code, emphasis and links.
  function markdownLine(text, state, out) {
    if (/^\s*(```|~~~)/.test(text)) {
      state.fence = !state.fence;
      out.push(['com', text]);
      return;
    }
    if (state.fence) return out.push(['str', text]);
    if (/^#{1,6}\s/.test(text)) return out.push(['kw', text]);
    if (/^\s*>/.test(text)) return out.push(['com', text]);
    const list = /^\s*([-*+]|\d+[.)])\s/.exec(text);
    let i = 0;
    if (list) {
      out.push(['kw', list[0]]);
      i = list[0].length;
    }
    while (i < text.length) {
      const code = at(/`[^`]*`/y, text, i);
      const strong = !code && at(/(\*\*|__)[^*_]+\1/y, text, i);
      const link = !code && !strong && at(/!?\[[^\]]*\]\([^)]*\)/y, text, i);
      const tok = code || strong || link;
      if (tok) {
        out.push([code ? 'str' : strong ? 'kw' : 'fn', tok]);
        i += tok.length;
        continue;
      }
      const plain = at(/[^`*_![]+/y, text, i) || text[i];
      out.push([null, plain]);
      i += plain.length;
    }
  }

  function codeLine(text, p, state, out) {
    let i = 0;
    const len = text.length;
    // A key at the start of a line (YAML, TOML, INI), or a [section].
    if (p.sections) {
      const sec = at(/\s*\[\[?[^\]]*\]\]?/y, text, 0);
      if (sec && !state.block) {
        out.push(['type', sec]);
        i = sec.length;
      }
    }
    if (p.targets && !state.block) {
      const target = at(/[A-Za-z0-9_.%/$() -]+(?=:(?!=))/y, text, 0);
      if (target && !/^\s/.test(text)) {
        out.push(['fn', target]);
        i = target.length;
      }
    }
    if (p.keys && !state.block && i === 0) {
      const lead = at(/\s*(- )?/y, text, 0) || '';
      const key = at(p.keys, text, lead.length);
      if (key) {
        out.push([null, lead], ['prop', key]);
        i = lead.length + key.length;
      }
    }
    if (p.preprocessor && !state.block && /^\s*#\s*\w+/.test(text)) {
      const m = /^\s*#\s*\w+/.exec(text)[0];
      out.push(['kw', m]);
      i = m.length;
    }
    let lastWord = '';
    while (i < len) {
      // Inside a comment or string that started on an earlier line.
      if (state.block) {
        const { close, cls } = state.block;
        const end = text.indexOf(close, i);
        const stop = end < 0 ? len : end + close.length;
        out.push([cls, text.slice(i, stop)]);
        if (end >= 0) state.block = null;
        i = stop;
        continue;
      }
      const ch = text[i];
      if (ch === ' ' || ch === '\t') {
        const ws = at(/[ \t]+/y, text, i);
        out.push([null, ws]);
        i += ws.length;
        continue;
      }
      if (p.attrs && ch === '#') {
        const attr = at(p.attrs, text, i);
        if (attr) {
          out.push(['attr', attr]);
          i += attr.length;
          continue;
        }
      }
      // Block openers first: Lua's "--[[" also starts with its line comment.
      const blockOpen = (p.block || []).find(([open]) => text.startsWith(open, i));
      const lineComment = !blockOpen && (p.line || []).find((c) => text.startsWith(c, i) && !(c === '#' && p.variables && text[i - 1] === '$'));
      if (blockOpen) {
        const cls = p.blockIsString && blockOpen[0] !== '/*' ? 'str' : 'com';
        state.block = { close: blockOpen[1], cls };
        out.push([cls, blockOpen[0]]);
        i += blockOpen[0].length;
        continue;
      }
      if (lineComment) {
        out.push(['com', text.slice(i)]);
        break;
      }
      if (p.multiQuote && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        const q = text.slice(i, i + 3);
        state.block = { close: q, cls: 'str' };
        out.push(['str', q]);
        i += 3;
        continue;
      }
      if ((p.multi || []).includes(ch)) {
        state.block = { close: ch, cls: 'str' };
        out.push(['str', ch]);
        i += 1;
        continue;
      }
      if ((p.quotes || []).includes(ch) || (p.char && ch === "'")) {
        if (ch === "'" && p.char) {
          // A character literal ('a', '\n'); otherwise a Rust lifetime.
          const lit = at(/'(\\(u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'])'/y, text, i);
          if (lit) {
            out.push(['str', lit]);
            i += lit.length;
            continue;
          }
          const life = p.lifetimes && at(/'[A-Za-z_]\w*/y, text, i);
          if (life) {
            out.push(['type', life]);
            i += life.length;
            continue;
          }
          out.push([null, ch]);
          i += 1;
          continue;
        }
        let j = i + 1;
        while (j < len && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
        const s = text.slice(i, Math.min(j + 1, len));
        const isKey = p.jsonKeys && /^\s*:/.test(text.slice(j + 1));
        out.push([isKey ? 'prop' : 'str', s]);
        i += s.length;
        continue;
      }
      if (p.variables && (ch === '$' || ch === '@')) {
        const v = at(p.variables, text, i);
        if (v) {
          out.push(['var', v]);
          i += v.length;
          continue;
        }
      }
      if (p.decorators && ch === '@') {
        const d = at(/@[\w.]+/y, text, i);
        if (d) {
          out.push(['attr', d]);
          i += d.length;
          continue;
        }
      }
      if (p.symbols && ch === ':' && /[A-Za-z_]/.test(text[i + 1] || '') && text[i - 1] !== ':') {
        const sym = at(/:[A-Za-z_]\w*[?!]?/y, text, i);
        out.push(['const', sym]);
        i += sym.length;
        continue;
      }
      if (p.css) {
        const prop = at(/[\w-]+(?=\s*:[^:])/y, text, i);
        if (prop && /^\s*$/.test(text.slice(0, i).replace(/.*[{;]/, ''))) {
          out.push(['prop', prop]);
          i += prop.length;
          continue;
        }
        const atRule = at(/@[\w-]+/y, text, i);
        const hex = !atRule && at(/#[0-9a-fA-F]{3,8}\b/y, text, i);
        const sel = !atRule && !hex && at(/[.#][\w-]+/y, text, i);
        const tok = atRule || hex || sel;
        if (tok) {
          out.push([atRule ? 'kw' : hex ? 'const' : 'type', tok]);
          i += tok.length;
          continue;
        }
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        const prev = text[i - 1] || '';
        if (!/[\w$]/.test(prev)) {
          const n = at(NUM, text, i);
          if (n) {
            out.push(['num', n]);
            i += n.length;
            continue;
          }
        }
      }
      const word = at(IDENT, text, i);
      if (word) {
        const key = p.caseless ? word.toLowerCase() : word;
        const next = text.slice(i + word.length);
        let cls = null;
        if (p.keywords?.has(key)) cls = 'kw';
        else if (p.constants?.has(key)) cls = 'const';
        else if (p.types?.has(key)) cls = 'type';
        else if (p.builtins?.has(key)) cls = 'fn';
        else if (p.macros && next[0] === '!' && next[1] !== '=') cls = 'fn';
        else if (/^\s*\(/.test(next) && !p.keys) cls = 'fn';
        else if (/^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word) && !p.keys) cls = 'type';
        else if (/^[A-Z][A-Z0-9_]{2,}$/.test(word) && !p.keys && !p.caseless) cls = 'const';
        else if (['fn', 'func', 'function', 'def', 'fun'].includes(lastWord)) cls = 'fn';
        else if (['struct', 'class', 'enum', 'trait', 'interface', 'type', 'impl', 'record'].includes(lastWord)) cls = 'type';
        out.push([cls, word]);
        lastWord = word;
        i += word.length;
        continue;
      }
      out.push([null, ch]);
      i += 1;
    }
  }

  // [[cls, text], …] per line; cls is null for plain text.
  function lines(list, profile) {
    const state = {};
    return list.map((text) => {
      const out = [];
      if (!profile || text.length > 2000) out.push([null, text]);
      else if (profile.markup) markupLine(text, state, out);
      else if (profile.markdown) markdownLine(text, state, out);
      else codeLine(text, profile, state, out);
      return out;
    });
  }

  // A line's tokens as nodes for a .ht-file-text span.
  function nodes(tokens) {
    return tokens.filter(([, t]) => t).map(([cls, t]) => (cls ? HT.h('span', { class: `tk-${cls}` }, t) : t));
  }

  return { forFile, lines, nodes, LANGS };
})();
