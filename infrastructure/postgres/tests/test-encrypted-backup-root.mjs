#!/usr/bin/env node

import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const parser = fileURLToPath(new URL("../verify-encrypted-backup-root.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "winerim-encrypted-backup-test-"));
const mount = join(root, "mounted");
const backupRoot = join(mount, "rescue-production-backups");
const encryptedImage = join(root, "backups.sparsebundle");
mkdirSync(backupRoot, { recursive: true });
writeFileSync(encryptedImage, "fixture");

function hdiutilRecord({ imagePath = encryptedImage, encrypted = "TRUE", mountPoint = mount, device = "/dev/disk9s1" }) {
  return `================================================\nimage-path      : ${imagePath}\nimage-encrypted : ${encrypted}\n/dev/disk9\tGUID_partition_scheme\t\n${device}\t41504653-0000-11AA-AA11-00306543ECAC\t${mountPoint}\n`;
}

function run(input, target = backupRoot, device = "/dev/disk9s1") {
  return spawnSync(process.execPath, [parser, target, device], { input, encoding: "utf8" });
}

const accepted = run(
  hdiutilRecord({ imagePath: join(root, "unrelated.sparsebundle"), encrypted: "FALSE", mountPoint: join(root, "other") })
    + hdiutilRecord({}),
);
if (accepted.status !== 0 || !accepted.stdout.includes(`mount=${realpathSync(mount)}`)) {
  throw new Error(`encrypted backing image was not accepted: ${accepted.stderr}`);
}

const unencrypted = run(hdiutilRecord({ encrypted: "FALSE" }));
if (unencrypted.status === 0 || !unencrypted.stderr.includes("BACKUP_ROOT_BACKING_IMAGE_NOT_ENCRYPTED")) {
  throw new Error("unencrypted backing image was not rejected");
}

const unrelated = run(hdiutilRecord({ mountPoint: join(root, "mounted-other") }));
if (unrelated.status === 0 || !unrelated.stderr.includes("BACKUP_ROOT_ENCRYPTED_IMAGE_MOUNT_NOT_FOUND")) {
  throw new Error("unrelated encrypted mount was not rejected");
}

const nestedDevice = run(hdiutilRecord({}), backupRoot, "/dev/disk10s1");
if (nestedDevice.status === 0 || !nestedDevice.stderr.includes("BACKUP_ROOT_DEVICE_NOT_ENCRYPTED_IMAGE")) {
  throw new Error("nested unencrypted filesystem device was not rejected");
}

const nestedMount = join(mount, "rescue-production-backups");
const nestedUnencrypted = run(
  hdiutilRecord({})
    + hdiutilRecord({
      imagePath: join(root, "nested-unencrypted.sparsebundle"),
      encrypted: "FALSE",
      mountPoint: nestedMount,
      device: "/dev/disk10s1",
    }),
  backupRoot,
  "/dev/disk10s1",
);
if (nestedUnencrypted.status === 0 || !nestedUnencrypted.stderr.includes("BACKUP_ROOT_BACKING_IMAGE_NOT_ENCRYPTED")) {
  throw new Error("nested unencrypted image was not rejected");
}

const missingImage = run(hdiutilRecord({ imagePath: join(root, "missing.sparsebundle") }));
if (missingImage.status === 0 || !missingImage.stderr.includes("BACKUP_ROOT_BACKING_IMAGE_NOT_READABLE")) {
  throw new Error("missing backing image was not rejected");
}

console.log("RESULT=ENCRYPTED_BACKUP_ROOT_TEST_OK");
