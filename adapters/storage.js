// StorageAdapter — Supabase Storage backed. Config: { client, bucket }.
// client is injected by the host app (same pattern as PostgresAdapter's
// config.db.client) — ark/ doesn't reach outside its own tree for
// credentials. Bucket is created lazily (idempotent) on first upload
// rather than requiring manual dashboard setup.

class StorageAdapter {
  constructor(config = {}) {
    this.client = config.client || null;
    this.bucket = config.bucket || 'ark-media';
    this._bucketReady = false;
  }

  async connect() {}

  async _ensureBucket() {
    if (this._bucketReady || !this.client) return;
    const { data: buckets } = await this.client.storage.listBuckets();
    if (!buckets?.some(b => b.name === this.bucket)) {
      const { error } = await this.client.storage.createBucket(this.bucket, { public: true });
      // Ignore "already exists" — a concurrent request may have created it first.
      if (error && !/already exists/i.test(error.message || '')) throw error;
    }
    this._bucketReady = true;
  }

  // file: { buffer, filename, contentType }
  async upload({ file, folder = 'uploads' }) {
    if (!this.client) throw new Error('StorageAdapter: no storage client configured');
    await this._ensureBucket();

    const objectPath = `${folder}/${file.filename}`;
    const { error } = await this.client.storage.from(this.bucket).upload(objectPath, file.buffer, {
      contentType: file.contentType || 'application/octet-stream',
      upsert: true,
    });
    if (error) throw new Error(`StorageAdapter upload failed: ${error.message}`);

    const { data } = this.client.storage.from(this.bucket).getPublicUrl(objectPath);
    return { path: objectPath, url: data.publicUrl };
  }

  async delete({ path }) {
    if (!this.client) throw new Error('StorageAdapter: no storage client configured');
    const { error } = await this.client.storage.from(this.bucket).remove([path]);
    if (error) throw new Error(`StorageAdapter delete failed: ${error.message}`);
  }

  url(path) {
    if (!this.client) return path;
    const { data } = this.client.storage.from(this.bucket).getPublicUrl(path);
    return data.publicUrl;
  }
}

module.exports = StorageAdapter;
