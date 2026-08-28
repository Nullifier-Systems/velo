import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { sanitizeImage } from "../../lib/workers/ocrSanitizationWorker.js";

// Mock tesseract.js to avoid downloading models during tests
vi.mock("tesseract.js", () => {
  return {
    createWorker: vi.fn().mockResolvedValue({
      recognize: vi.fn().mockResolvedValue({
        data: {
          text: "Here is a test credit card: 4111 1111 1111 1111 and some other text.",
          words: [
            { text: "Here", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
            { text: "is", bbox: { x0: 12, y0: 0, x1: 20, y1: 10 } },
            { text: "a", bbox: { x0: 22, y0: 0, x1: 30, y1: 10 } },
            { text: "test", bbox: { x0: 32, y0: 0, x1: 40, y1: 10 } },
            { text: "credit", bbox: { x0: 42, y0: 0, x1: 50, y1: 10 } },
            { text: "card:", bbox: { x0: 52, y0: 0, x1: 60, y1: 10 } },
            { text: "4111", bbox: { x0: 62, y0: 0, x1: 70, y1: 10 } },
            { text: "1111", bbox: { x0: 72, y0: 0, x1: 80, y1: 10 } },
            { text: "1111", bbox: { x0: 82, y0: 0, x1: 90, y1: 10 } },
            { text: "1111", bbox: { x0: 92, y0: 0, x1: 100, y1: 10 } },
            { text: "and", bbox: { x0: 102, y0: 0, x1: 110, y1: 10 } },
          ],
        },
      }),
      terminate: vi.fn().mockResolvedValue(true),
    }),
  };
});

describe("Dispute Sanitization Pipeline", () => {
  it("strips EXIF metadata from image", async () => {
    // Create a mock image with EXIF data
    const exifData = {
      IFD0: {
        Make: "TestCamera",
        Model: "TestModel",
      },
    };
    const imageBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    }).jpeg().withMetadata({ exif: exifData }).toBuffer();

    const initialMetadata = await sharp(imageBuffer).metadata();
    expect(initialMetadata.exif).toBeDefined();

    const { sanitizedBuffer, exifRemoved } = await sanitizeImage(imageBuffer);

    expect(exifRemoved).toBe(true);
    const finalMetadata = await sharp(sanitizedBuffer).metadata();
    expect(finalMetadata.exif).toBeUndefined();
  });

  it("detects and redacts PII (credit card number)", async () => {
    const imageBuffer = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    }).jpeg().toBuffer();

    const { piiRedactionsCount, sanitizedBuffer, sanitizedFileHash } = await sanitizeImage(imageBuffer);

    // Our mocked text contains exactly 1 credit card number (16 digits)
    expect(piiRedactionsCount).toBe(1);
    expect(sanitizedBuffer).toBeDefined();
    expect(sanitizedFileHash).toBeDefined();
  });
});
