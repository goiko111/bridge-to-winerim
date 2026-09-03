#!/usr/bin/env node

import { accessSync, constants, realpathSync } from "node:fs";

const backupRootArg = process.argv[2];
const backupRootDevice = process.argv[3];
if (!backupRootArg || !backupRootArg.startsWith("/")) {
  console.error("ABSOLUTE_BACKUP_ROOT_REQUIRED");
  process.exit(2);
}
if (!backupRootDevice || !backupRootDevice.startsWith("/dev/")) {
  console.error("BACKUP_ROOT_DEVICE_REQUIRED");
  process.exit(2);
}

let backupRoot;
try {
  backupRoot = realpathSync(backupRootArg);
} catch {
  console.error("BACKUP_ROOT_REALPATH_REJECTED");
  process.exit(3);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

const records = [];
let current = null;
for (const rawLine of input.split(/\r?\n/)) {
  const line = rawLine.trimEnd();
  const imageMatch = line.match(/^image-path\s*:\s*(.+)$/);
  if (imageMatch) {
    if (current) records.push(current);
    current = { imagePath: imageMatch[1].trim(), encrypted: false, mounts: [] };
    continue;
  }
  if (!current) continue;
  const encryptedMatch = line.match(/^image-encrypted\s*:\s*(\S+)$/i);
  if (encryptedMatch) {
    current.encrypted = encryptedMatch[1].toUpperCase() === "TRUE";
    continue;
  }
  if (!line.startsWith("/dev/")) continue;
  const fields = line.split("\t").filter(Boolean);
  const device = fields[0]?.trim();
  const mount = fields.at(-1)?.trim();
  if (device?.startsWith("/dev/") && mount?.startsWith("/")) current.mounts.push({ device, mount });
}
if (current) records.push(current);

const candidates = records.flatMap((record) =>
  record.mounts.flatMap(({ device, mount }) => {
    let resolvedMount;
    try {
      resolvedMount = realpathSync(mount);
    } catch {
      return [];
    }
    if (backupRoot !== resolvedMount && !backupRoot.startsWith(`${resolvedMount}/`)) return [];
    return [{ ...record, device, mount: resolvedMount }];
  }),
);
candidates.sort((left, right) => right.mount.length - left.mount.length);
const matched = candidates[0];

if (!matched) {
  console.error("BACKUP_ROOT_ENCRYPTED_IMAGE_MOUNT_NOT_FOUND");
  process.exit(3);
}
if (matched.device !== backupRootDevice) {
  console.error("BACKUP_ROOT_DEVICE_NOT_ENCRYPTED_IMAGE");
  process.exit(3);
}
if (!matched.encrypted) {
  console.error("BACKUP_ROOT_BACKING_IMAGE_NOT_ENCRYPTED");
  process.exit(3);
}
if (!matched.imagePath.startsWith("/")) {
  console.error("BACKUP_ROOT_BACKING_IMAGE_PATH_REJECTED");
  process.exit(3);
}
try {
  accessSync(matched.imagePath, constants.R_OK);
} catch {
  console.error("BACKUP_ROOT_BACKING_IMAGE_NOT_READABLE");
  process.exit(3);
}

process.stdout.write(`ENCRYPTED_BACKUP_IMAGE_OK mount=${matched.mount} device=${matched.device}\n`);
