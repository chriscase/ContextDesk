import type { FileHandle } from "node:fs/promises";

/**
 * Random-access read over bytes that may live on disk.
 *
 * The archive reader works through this instead of a `Uint8Array` so the same
 * parser serves the inline lane (bytes already in memory, bounded by the
 * request limit) and the streamed lane (a spooled archive far larger than the
 * process should ever hold). Nothing here materializes the whole source.
 */
export interface ByteSource {
  readonly byteLength: number;
  /** Read exactly `length` bytes at `offset`, or throw if the range is short. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export class ByteRangeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ByteRangeError";
  }
}

export function memoryByteSource(bytes: Uint8Array): ByteSource {
  return {
    byteLength: bytes.byteLength,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
        throw new ByteRangeError("read past the end of the source");
      }
      return bytes.subarray(offset, offset + length);
    },
  };
}

export function fileByteSource(handle: FileHandle, byteLength: number): ByteSource {
  return {
    byteLength,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > byteLength) {
        throw new ByteRangeError("read past the end of the source");
      }
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead === 0) throw new ByteRangeError("source ended before the requested range");
        filled += bytesRead;
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, length);
    },
  };
}
