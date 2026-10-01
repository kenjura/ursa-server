import { createFsSource } from "./source/fs.js";
import { createS3Source } from "./source/s3.js";
import { createDropboxSource } from "./source/dropbox.js";
import { createGDriveSource } from "./source/gdrive.js";
import { createFsSink } from "./sink/fs.js";
import { createS3Sink } from "./sink/s3.js";
import { createRsyncSink } from "./sink/rsync.js";

export const sources = {
  fs: createFsSource,
  s3: createS3Source,
  dropbox: createDropboxSource,
  gdrive: createGDriveSource,
};

export const sinks = {
  fs: createFsSink,
  s3: createS3Sink,
  rsync: createRsyncSink,
};
