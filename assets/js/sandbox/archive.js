// 압축 파일: zip(JSZip) · tar · tar.gz/tgz · gz
let jszipP = null;
export function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipP ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => {
      jszipP = null;
      reject(new Error('압축 도구를 불러오지 못했습니다'));
    };
    document.head.append(s);
  });
  return jszipP;
}

export function archiveKind(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tgz';
  if (n.endsWith('.tar')) return 'tar';
  if (n.endsWith('.gz')) return 'gz';
  return null;
}

export function archiveBase(name) {
  return name.replace(/\.(zip|tar\.gz|tgz|tar|gz)$/i, '') || 'archive';
}

async function gunzip(bytes) {
  if (!('DecompressionStream' in window)) throw new Error('이 브라우저는 gzip 해제를 지원하지 않습니다');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function untar(bytes) {
  const out = [];
  const dec = new TextDecoder();
  const str = (o, l) => dec.decode(bytes.subarray(o, o + l)).replace(/\0.*$/s, '');
  let off = 0;
  let longName = null;
  while (off + 512 <= bytes.length) {
    if (bytes.subarray(off, off + 512).every((b) => b === 0)) break;
    let name = str(off, 100);
    const size = parseInt(str(off + 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(bytes[off + 156] || 48);
    const prefix = str(off + 345, 155);
    if (prefix) name = prefix + '/' + name;
    const dataStart = off + 512;
    if (type === 'L') {
      longName = dec.decode(bytes.subarray(dataStart, dataStart + size)).replace(/\0.*$/s, '');
    } else {
      if (longName) {
        name = longName;
        longName = null;
      }
      if (type === '5') out.push({ path: name.replace(/\/$/, ''), dir: true, size: 0 });
      else if (type === '0' || type === '\0' || type === '7') out.push({ path: name, dir: false, size, data: bytes.slice(dataStart, dataStart + size) });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

const clean = (p) => p.split('/').filter((x) => x && x !== '.' && x !== '..').join('/');

/** → [{ path, dir, size, data?: Uint8Array | () => Promise<Uint8Array> }] */
export async function readArchive(bytes, name) {
  const kind = archiveKind(name);
  if (kind === 'zip') {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(bytes);
    const out = [];
    zip.forEach((p, f) => {
      const path = clean(p);
      if (!path) return;
      out.push({ path, dir: f.dir, size: f._data?.uncompressedSize ?? 0, data: f.dir ? null : () => f.async('uint8array') });
    });
    return out;
  }
  if (kind === 'tar') return untar(bytes).map((e) => ({ ...e, path: clean(e.path) })).filter((e) => e.path);
  if (kind === 'tgz') return untar(await gunzip(bytes)).map((e) => ({ ...e, path: clean(e.path) })).filter((e) => e.path);
  if (kind === 'gz') {
    const data = await gunzip(bytes);
    return [{ path: archiveBase(name), dir: false, size: data.length, data }];
  }
  throw new Error('지원하지 않는 압축 형식입니다');
}

export async function entryBytes(e) {
  return typeof e.data === 'function' ? e.data() : e.data;
}

/** files: [{ path, bytes }] → zip Blob */
export async function makeZip(files) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.bytes);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
