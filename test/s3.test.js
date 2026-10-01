import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { createS3Sink, invalidationPaths } from "../src/adapters/sink/s3.js";
import { normalize } from "../src/config/load.js";
import { tempDir, put, quiet } from "./helpers.js";

function sinkConfig(extra = {}) {
  return normalize({ sites: [{ source: { path: "/s" }, sink: { type: "s3", bucket: "b", prefix: "site", ...extra } }] }, {}, { warn: quiet }).sites[0].sink;
}

function fakeClient(responses = {}) {
  const sent = [];
  return {
    sent,
    async send(cmd) {
      const name = cmd.constructor.name;
      sent.push({ name, input: cmd.input });
      if (cmd.input.Body?.resume) cmd.input.Body.resume(); // drain the stream
      const r = responses[name];
      return typeof r === "function" ? r(cmd.input, sent.length) : r ?? {};
    },
  };
}

test("put: key under the prefix, content type and cache control by kind", async (t) => {
  const dir = await tempDir(t);
  const s3 = fakeClient();
  const sink = createS3Sink(sinkConfig(), { s3 });
  await sink.put("a/b.html", await put(dir, "b.html", "<p>"));
  await sink.put("public/x.css", await put(dir, "x.css", "body{}"));
  await sink.put("public/menu-data.json", await put(dir, "m.json", "{}"));
  const [html, css, json] = s3.sent.map((s) => s.input);
  assert.equal(html.Key, "site/a/b.html");
  assert.equal(html.ContentType, "text/html; charset=utf-8");
  assert.match(html.CacheControl, /max-age=0/);
  assert.equal(css.ContentType, "text/css; charset=utf-8");
  assert.equal(css.CacheControl, "public, max-age=3600");
  assert.match(json.CacheControl, /max-age=0/);
});

test("list pages through the bucket and strips ETag quotes", async () => {
  const s3 = fakeClient({
    ListObjectsV2Command: (input) => input.ContinuationToken
      ? { Contents: [{ Key: "site/b.html", ETag: '"bbb"' }], IsTruncated: false }
      : { Contents: [{ Key: "site/a.html", ETag: '"aaa"' }], IsTruncated: true, NextContinuationToken: "t" },
  });
  const listed = await createS3Sink(sinkConfig(), { s3 }).list();
  assert.deepEqual([...listed], [["a.html", "aaa"], ["b.html", "bbb"]]);
});

test("remove reports per-object errors", async () => {
  const s3 = fakeClient({ DeleteObjectsCommand: { Errors: [{ Key: "site/a.html", Code: "AccessDenied" }] } });
  await assert.rejects(createS3Sink(sinkConfig(), { s3 }).remove(["a.html"]), /AccessDenied/);
  assert.deepEqual(s3.sent[0].input.Delete.Objects, [{ Key: "site/a.html" }]);
});

test("commit invalidates every URL form of changed pages, or everything past maxPaths", async () => {
  const cloudfront = fakeClient();
  const sink = createS3Sink(sinkConfig({ cloudfront: { distributionId: "E1", maxPaths: 4 } }), { s3: fakeClient(), cloudfront });
  const paths = await sink.commit(["docs/index.html"]);
  assert.deepEqual(paths, ["/site/docs/", "/site/docs/index", "/site/docs/index.html"]);
  assert.equal(cloudfront.sent[0].input.DistributionId, "E1");

  const many = await sink.commit(["a.html", "b.html", "c.css"]);
  assert.deepEqual(many, ["/site/*"]);
});

test("invalidationPaths escapes spaces and handles the root index", () => {
  assert.deepEqual(invalidationPaths(["index.html", "my page.html"]), ["/", "/index", "/index.html", "/my%20page", "/my%20page.html"]);
});

test("without CloudFront, commit does nothing", async () => {
  assert.equal(await createS3Sink(sinkConfig(), { s3: fakeClient() }).commit(["a.html"]), null);
});
