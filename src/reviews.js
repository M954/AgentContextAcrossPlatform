'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readBoundedFile, writePrivateJson } = require('./local-files');
const { MAX_BUNDLE_BYTES } = require('./bundle');
const { contentHash } = require('./snapshot');

const REVIEW_TTL = 15 * 60 * 1000;

class ReviewStore {
  constructor(stateDir) { this.root = path.join(stateDir, 'reviews'); }

  file(reviewId) {
    if (!/^review_[a-f0-9]{32}$/.test(reviewId || '')) throw new Error('Invalid review ID');
    return path.join(this.root, `${reviewId}.json`);
  }

  async create(plan) {
    const review = {
      reviewId: `review_${crypto.randomBytes(16).toString('hex')}`,
      expiresAt: new Date(Date.now() + REVIEW_TTL).toISOString(),
      plan,
    };
    review.digest = contentHash(review);
    const previewPath = this.file(review.reviewId);
    await writePrivateJson(previewPath, review);
    return { ...review, previewPath };
  }

  async get(reviewId) {
    const bytes = await readBoundedFile(this.file(reviewId), MAX_BUNDLE_BYTES * 2);
    const review = JSON.parse(bytes.toString('utf8'));
    const { digest, ...unsigned } = review;
    if (review.reviewId !== reviewId || contentHash(unsigned) !== digest) {
      throw new Error('Review changed; prepare and inspect a new draft');
    }
    if (!Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= Date.now()) {
      throw new Error('Review expired; prepare a new draft');
    }
    return { ...review, previewPath: this.file(reviewId) };
  }

  async execute(reviewId, { identity, fingerprint, confirm, perform }) {
    const review = await this.get(reviewId);
    if (review.plan.identity !== identity || review.plan.configuration !== fingerprint) {
      throw new Error('Account or configuration changed; prepare a new review');
    }
    const statePath = `${this.file(reviewId)}.result`;
    try {
      const result = JSON.parse((await readBoundedFile(statePath, MAX_BUNDLE_BYTES)).toString('utf8'));
      return result;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (typeof confirm !== 'function') throw new Error('A trusted interactive approval UI is required');
    const approvedDigest = review.digest;
    // UI code receives a copy: presentation must not mutate the executable plan.
    if (await confirm(structuredClone(review)) !== true) return { status: 'cancelled', reviewId };
    const unchanged = await this.get(reviewId);
    if (unchanged.digest !== approvedDigest) throw new Error('Review changed during confirmation');
    const lock = `${this.file(reviewId)}.claimed`;
    try {
      await fs.writeFile(lock, approvedDigest, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error('This review is already running or had an incomplete attempt. Inspect its result and prepare a new review if needed.');
      }
      throw error;
    }
    // Claims are retained after ambiguous failures: never silently duplicate an upload or import.
    const result = await perform(unchanged.plan);
    await writePrivateJson(statePath, result);
    return result;
  }
}

module.exports = { REVIEW_TTL, ReviewStore };
