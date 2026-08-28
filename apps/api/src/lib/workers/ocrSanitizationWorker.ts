import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import crypto from "node:crypto";

export interface SanitizationResult {
  sanitizedBuffer: Buffer;
  piiRedactionsCount: number;
  exifRemoved: boolean;
  sanitizedFileHash: string;
}

async function sanitizeImage(imageBuffer: Buffer): Promise<SanitizationResult> {
  // Read image dimensions
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;

  // Run OCR
  const worker = await createWorker('eng');
  const { data: { text, words } } = await worker.recognize(imageBuffer);
  await worker.terminate();

  const ccRegex = /\b(?:\d[ -]*?){13,16}\b/g;
  
  // Find all words that overlap with CC matches
  const matches = [...text.matchAll(ccRegex)];
  
  let piiRedactionsCount = matches.length;
  let svgRects = '';

  if (piiRedactionsCount > 0) {
    // Re-run recognition to get word-level bounding boxes
    // Actually, Tesseract's `words` array already gives us bounding boxes for each word.
    // We can just construct SVG rects over the words that look like credit card numbers.
    // Since credit card numbers might be split across multiple words, we need to handle that.
    // Alternatively, just redact any word that is purely digits and part of a sequence,
    // or just search the `words` array directly for sequences of 13-16 digits.
    
    let currentSequence = "";
    let sequenceWords: typeof words = [];
    
    for (const word of words) {
      const stripped = word.text.replace(/[^0-9]/g, '');
      if (stripped.length > 0) {
        currentSequence += stripped;
        sequenceWords.push(word);
        
        if (currentSequence.length >= 13 && currentSequence.length <= 16) {
          // Redact this sequence
          for (const seqWord of sequenceWords) {
            svgRects += `<rect x="${seqWord.bbox.x0}" y="${seqWord.bbox.y0}" width="${seqWord.bbox.x1 - seqWord.bbox.x0}" height="${seqWord.bbox.y1 - seqWord.bbox.y0}" fill="black" />`;
          }
          currentSequence = "";
          sequenceWords = [];
        } else if (currentSequence.length > 16) {
          // Reset if we overshoot
          currentSequence = stripped;
          sequenceWords = [word];
        }
      } else {
        // Reset if we hit a non-digit word (ignoring spaces since tesseract breaks words by space)
        currentSequence = "";
        sequenceWords = [];
      }
    }
  }

  // Use sharp to strip EXIF and apply redactions
  let imageProcessor = sharp(imageBuffer);
  
  if (svgRects.length > 0) {
    const svgOverlay = Buffer.from(`<svg viewBox="0 0 ${width} ${height}">${svgRects}</svg>`);
    imageProcessor = imageProcessor.composite([{ input: svgOverlay }]);
  }

  // Calling toBuffer() without withMetadata() automatically strips EXIF
  const sanitizedBuffer = await imageProcessor.toBuffer();
  
  const hash = crypto.createHash("sha256").update(sanitizedBuffer).digest("hex");

  return {
    sanitizedBuffer,
    piiRedactionsCount,
    exifRemoved: true,
    sanitizedFileHash: hash,
  };
}

if (parentPort) {
  parentPort.on("message", async (imageBuffer: Buffer) => {
    try {
      const result = await sanitizeImage(imageBuffer);
      parentPort!.postMessage({ success: true, result });
    } catch (error) {
      parentPort!.postMessage({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

// For cases where we want to call it directly in the same thread (e.g. tests)
export { sanitizeImage };
