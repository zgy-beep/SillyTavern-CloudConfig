/** Publish immutable files before database metadata. A failed transaction leaves no live reference. */
export class SnapshotCommitter {
  constructor(store) { this.store = store; }

  async stage(directories, contentType, itemUid, version, ext, buffer) {
    const prepared = await this.store.prepareTempBlob(directories, contentType, itemUid, version, ext, buffer);
    try {
      await this.store.commitBlob(prepared.tmpPath, prepared.targetPath);
      return prepared.targetPath;
    } catch (error) {
      await this.store.deleteBlob(prepared.tmpPath).catch(() => {});
      await this.store.deleteBlob(prepared.targetPath).catch(() => {});
      throw error;
    }
  }

  async discard(paths) {
    await Promise.all(paths.filter(Boolean).map(p => this.store.deleteBlob(p).catch(() => {})));
  }
}
