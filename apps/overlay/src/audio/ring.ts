export class SampleRing {
  private readonly storage: Float32Array;
  private readIndex = 0;
  private writeIndex = 0;
  private count = 0;
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new RangeError("Invalid ring capacity");
    this.storage = new Float32Array(capacity);
  }
  get available(): number {
    return this.count;
  }
  push(samples: Float32Array): boolean {
    if (samples.length > this.capacity - this.count) return false;
    for (const sample of samples) {
      this.storage[this.writeIndex] = sample;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.count += samples.length;
    return true;
  }
  read(output: Float32Array, offset = 0, limit = output.length - offset): number {
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(limit) ||
      offset < 0 ||
      limit < 0 ||
      offset + limit > output.length
    )
      throw new RangeError("Invalid output span");
    output.fill(0, offset, offset + limit);
    const amount = Math.min(limit, this.count);
    for (let index = 0; index < amount; index++) {
      output[offset + index] = this.storage[this.readIndex] ?? 0;
      this.readIndex = (this.readIndex + 1) % this.capacity;
    }
    this.count -= amount;
    return amount;
  }
  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.count = 0;
  }
}
