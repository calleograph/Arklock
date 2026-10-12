// Учебный S3-сервер для проверки scripts/remote.sh: проверяет подпись AWS Signature V4 по спецификации и хэш тела,
// поддерживает PUT/GET/HEAD/DELETE, список v2 с постраничным выводом и многочастную загрузку.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';

const sha = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
const enc = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );

export function startS3({ bucket, accessKey, secretKey, region, pageSize = 1000 }) {
  const objects = new Map(); // key -> { body, meta, modified }
  const uploads = new Map(); // id -> { key, meta, parts: Map }
  const log = [];
  const state = { objects, uploads, log, failNext: 0, failWhen: null };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, text = '', headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/xml', ...headers });
        res.end(req.method === 'HEAD' ? undefined : text);
      };
      const err = (status, code) =>
        send(status, `<?xml version="1.0"?><Error><Code>${code}</Code></Error>`);
      try {
        const url = new URL(req.url, 'http://x');
        // --- проверка подписи
        const auth = req.headers.authorization ?? '';
        const m =
          /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
            auth,
          );
        if (!m) return err(403, 'AccessDenied');
        const [, ak, date, rg, signedHeaders, signature] = m;
        if (ak !== accessKey || rg !== region) return err(403, 'InvalidAccessKeyId');
        const amzDate = req.headers['x-amz-date'];
        if (!amzDate || !amzDate.startsWith(date)) return err(403, 'AccessDenied');
        const skew = Math.abs(
          Date.now() -
            Date.parse(
              amzDate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'),
            ),
        );
        if (skew > 15 * 60_000) return err(403, 'RequestTimeTooSkewed');
        const payloadHash = req.headers['x-amz-content-sha256'];
        if (payloadHash !== sha(body)) return err(400, 'XAmzContentSHA256Mismatch');
        const canonQuery = [...url.searchParams.entries()]
          .map(([k, v]) => [enc(k), enc(v)])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
          .map(([k, v]) => `${k}=${v}`)
          .join('&');
        const canonHeaders = signedHeaders
          .split(';')
          .map((h) => `${h}:${String(req.headers[h] ?? '').trim()}\n`)
          .join('');
        const rawPath = url.pathname
          .split('/')
          .map((seg) => enc(decodeURIComponent(seg)))
          .join('/');
        const canon = [
          req.method,
          rawPath,
          canonQuery,
          canonHeaders,
          signedHeaders,
          payloadHash,
        ].join('\n');
        const sts = ['AWS4-HMAC-SHA256', amzDate, `${date}/${rg}/s3/aws4_request`, sha(canon)].join(
          '\n',
        );
        const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), rg), 's3'), 'aws4_request');
        if (createHmac('sha256', key).update(sts).digest('hex') !== signature)
          return err(403, 'SignatureDoesNotMatch');
        log.push(`${req.method} ${url.pathname}${url.search}`);
        if (state.failNext > 0) {
          state.failNext--;
          return err(500, 'InternalError');
        }
        // однократный отказ на запросе, подходящем под условие
        if (state.failWhen && state.failWhen(log[log.length - 1])) {
          state.failWhen = null;
          return err(500, 'InternalError');
        }

        // --- маршруты
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (parts[0] !== bucket) return err(404, 'NoSuchBucket');
        const objKey = parts.slice(1).join('/');
        const q = url.searchParams;

        if (!objKey && req.method === 'GET' && q.get('list-type') === '2') {
          const prefix = q.get('prefix') ?? '';
          const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
          const start = q.get('continuation-token') ? Number(q.get('continuation-token')) : 0;
          const page = keys.slice(start, start + pageSize);
          const more = start + pageSize < keys.length;
          const xml =
            `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>` +
            (more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : '') +
            page
              .map(
                (k) =>
                  `<Contents><Key>${k}</Key><LastModified>${objects.get(k).modified}</LastModified><Size>${objects.get(k).body.length}</Size></Contents>`,
              )
              .join('') +
            `</ListBucketResult>`;
          return send(200, xml);
        }
        if (req.method === 'POST' && q.has('uploads')) {
          const id = randomBytes(8).toString('hex');
          uploads.set(id, {
            key: objKey,
            meta: req.headers['x-amz-meta-sha256'],
            parts: new Map(),
          });
          return send(
            200,
            `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
          );
        }
        if (req.method === 'PUT' && q.has('uploadId')) {
          const up = uploads.get(q.get('uploadId'));
          if (!up) return err(404, 'NoSuchUpload');
          up.parts.set(Number(q.get('partNumber')), body);
          return send(200, '', { etag: `"${sha(body).slice(0, 32)}"` });
        }
        if (req.method === 'POST' && q.has('uploadId')) {
          const up = uploads.get(q.get('uploadId'));
          if (!up) return err(404, 'NoSuchUpload');
          const order = [
            ...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g),
          ];
          const bufs = order.map((o) => {
            const part = up.parts.get(Number(o[1]));
            if (!part || o[2].replace(/"/g, '') !== sha(part).slice(0, 32))
              throw new Error(
                'InvalidPart:' + o[1] + ':' + (part ? part.length : 'nopart') + ':' + o[2],
              );
            return part;
          });
          objects.set(up.key, {
            body: Buffer.concat(bufs),
            meta: up.meta,
            modified: new Date().toISOString(),
          });
          uploads.delete(q.get('uploadId'));
          return send(
            200,
            `<?xml version="1.0"?><CompleteMultipartUploadResult><Key>${up.key}</Key></CompleteMultipartUploadResult>`,
          );
        }
        if (req.method === 'DELETE' && q.has('uploadId')) {
          uploads.delete(q.get('uploadId'));
          return send(204);
        }
        if (req.method === 'PUT') {
          objects.set(objKey, {
            body,
            meta: req.headers['x-amz-meta-sha256'],
            modified: new Date().toISOString(),
          });
          return send(200, '', { etag: `"${sha(body).slice(0, 32)}"` });
        }
        const obj = objects.get(objKey);
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!obj) return err(404, 'NoSuchKey');
          res.writeHead(200, {
            'content-length': obj.body.length,
            'x-amz-meta-sha256': obj.meta ?? '',
          });
          return res.end(req.method === 'HEAD' ? undefined : obj.body);
        }
        if (req.method === 'DELETE') {
          objects.delete(objKey);
          return send(204);
        }
        return err(405, 'MethodNotAllowed');
      } catch (e) {
        return err(400, String(e.message).replace(/[^A-Za-z]/g, ''));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ ...state, port: server.address().port, close: () => server.close(), state }),
    ),
  );
}
