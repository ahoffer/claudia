/**
 * Ring Buffer implementation for efficient output history management
 * Provides O(1) operations for append and maintains a maximum size
 */

/**
 * A ring buffer that stores Buffer chunks with a maximum total size
 * Automatically removes oldest entries when capacity is exceeded
 */
export class BufferRingBuffer {
    private chunks: Buffer[] = [];
    private totalSize: number = 0;
    private readonly maxSize: number;

    /**
     * Creates a new BufferRingBuffer
     * @param maxSize - Maximum total size in bytes (default: 2MB)
     */
    constructor(maxSize: number = 2 * 1024 * 1024) {
        this.maxSize = maxSize;
    }

    /**
     * Appends a buffer chunk to the ring buffer
     * Automatically removes oldest chunks if max size is exceeded
     * @param buffer - The buffer to append
     */
    push(buffer: Buffer): void {
        this.chunks.push(buffer);
        this.totalSize += buffer.length;

        // Remove oldest chunks until we're under the max size
        while (this.totalSize > this.maxSize && this.chunks.length > 1) {
            const removed = this.chunks.shift();
            if (removed) {
                this.totalSize -= removed.length;
            }
        }

        // If a single chunk exceeds maxSize, truncate it (keep the tail)
        if (this.chunks.length === 1 && this.totalSize > this.maxSize) {
            const truncated = this.chunks[0].subarray(this.chunks[0].length - this.maxSize);
            this.chunks[0] = truncated;
            this.totalSize = truncated.length;
        }
    }

    /**
     * Gets the total size of all chunks
     * @returns Total size in bytes
     */
    size(): number {
        return this.totalSize;
    }

    /**
     * Gets the number of chunks
     * @returns Number of chunks
     */
    length(): number {
        return this.chunks.length;
    }

    /**
     * Gets the last N bytes from the buffer
     * @param maxBytes - Maximum number of bytes to retrieve
     * @returns Combined string of the last N bytes
     */
    getLastBytes(maxBytes: number): string {
        const buffers: Buffer[] = [];
        let collected = 0;

        // Read from end backwards
        for (let i = this.chunks.length - 1; i >= 0 && collected < maxBytes; i--) {
            const chunk = this.chunks[i];
            buffers.unshift(chunk);
            collected += chunk.length;
        }

        const combined = Buffer.concat(buffers);
        const str = combined.toString('utf8');
        return str.slice(-maxBytes);
    }

    /**
     * Concatenates all chunks into a single buffer
     * @returns Single buffer containing all data
     */
    toBuffer(): Buffer {
        return Buffer.concat(this.chunks);
    }

    /**
     * Converts all chunks to a string
     * @returns String containing all data
     */
    toString(): string {
        return this.toBuffer().toString('utf8');
    }

    /**
     * Clears all chunks
     */
    clear(): void {
        this.chunks = [];
        this.totalSize = 0;
    }

    /**
     * Returns the underlying chunks array (for iteration)
     * @returns Array of buffer chunks
     */
    getChunks(): Buffer[] {
        return this.chunks;
    }

    /**
     * Reduces over all chunks
     * @param fn - Reducer function
     * @param initial - Initial value
     * @returns Reduced value
     */
    reduce<T>(fn: (acc: T, chunk: Buffer) => T, initial: T): T {
        return this.chunks.reduce(fn, initial);
    }
}
