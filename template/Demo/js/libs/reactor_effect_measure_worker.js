// Read effect coverage away from the game's update/render thread.
let canvas, context;
self.onmessage = ({ data: job }) => {
    try {
        canvas ||= new OffscreenCanvas(1, 1);
        if (canvas.width !== job.width || canvas.height !== job.height) {
            canvas.width = job.width; canvas.height = job.height;
        }
        context ||= canvas.getContext('2d', { willReadFrequently: true });
        context.clearRect(0, 0, job.width, job.height);
        if (job.pixels) {
            const source = new OffscreenCanvas(job.sourceWidth, job.sourceHeight), c = source.getContext('2d');
            const flipped = new Uint8ClampedArray(job.pixels.length), row = job.sourceWidth * 4;
            for (let y=0;y<job.sourceHeight;y++) flipped.set(job.pixels.subarray(y*row,(y+1)*row),(job.sourceHeight-y-1)*row);
            c.putImageData(new ImageData(flipped,job.sourceWidth,job.sourceHeight),0,0);
            context.drawImage(source,0,0,job.width,job.height);
        } else { context.drawImage(job.bitmap, 0, 0, job.width, job.height); job.bitmap.close(); }
        const pixels = context.getImageData(0, 0, job.width, job.height).data;
        self.postMessage({ id: job.id, pixels }, [pixels.buffer]);
    } catch (error) {
        job.bitmap?.close();
        self.postMessage({ id: job.id, error: String(error?.message || error) });
    }
};
