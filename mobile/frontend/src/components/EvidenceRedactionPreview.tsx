import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { createWorker } from "tesseract.js";

interface EvidenceRedactionPreviewProps {
  tradeId: string;
  onCancel: () => void;
  onUploadSuccess: () => void;
}

export default function EvidenceRedactionPreview({
  tradeId,
  onCancel,
  onUploadSuccess,
}: EvidenceRedactionPreviewProps) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [redactionsCount, setRedactionsCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      await processImage(selectedFile);
    }
  };

  const processImage = async (imageFile: File) => {
    setIsProcessing(true);
    setError(null);
    setRedactionsCount(0);
    
    try {
      const imageUrl = URL.createObjectURL(imageFile);
      const img = new Image();
      img.src = imageUrl;

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Match canvas to image dimensions (or scale down for preview)
      const MAX_WIDTH = 800;
      let width = img.width;
      let height = img.height;
      
      if (width > MAX_WIDTH) {
        height = Math.floor(height * (MAX_WIDTH / width));
        width = MAX_WIDTH;
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      // Scale factor if we resized the image
      const scaleX = width / img.width;
      const scaleY = height / img.height;

      const worker = await createWorker('eng');
      const { data: { text, words } } = await worker.recognize(img);
      await worker.terminate();

      // Find CC numbers
      const ccRegex = /\b(?:\d[ -]*?){13,16}\b/g;
      const matches = [...text.matchAll(ccRegex)];
      let detectedCount = matches.length;

      if (detectedCount > 0) {
        ctx.fillStyle = "black";
        
        let currentSequence = "";
        let sequenceWords: typeof words = [];
        let actualRedactions = 0;
        
        for (const word of words) {
          const stripped = word.text.replace(/[^0-9]/g, '');
          if (stripped.length > 0) {
            currentSequence += stripped;
            sequenceWords.push(word);
            
            if (currentSequence.length >= 13 && currentSequence.length <= 16) {
              actualRedactions++;
              // Draw black box over each word in the sequence
              for (const seqWord of sequenceWords) {
                const x = seqWord.bbox.x0 * scaleX;
                const y = seqWord.bbox.y0 * scaleY;
                const w = (seqWord.bbox.x1 - seqWord.bbox.x0) * scaleX;
                const h = (seqWord.bbox.y1 - seqWord.bbox.y0) * scaleY;
                ctx.fillRect(x, y, w, h);
              }
              currentSequence = "";
              sequenceWords = [];
            } else if (currentSequence.length > 16) {
              currentSequence = stripped;
              sequenceWords = [word];
            }
          } else {
            currentSequence = "";
            sequenceWords = [];
          }
        }
        
        setRedactionsCount(actualRedactions > 0 ? actualRedactions : detectedCount);
      }

      URL.revokeObjectURL(imageUrl);
    } catch (err) {
      console.error(err);
      setError("Failed to process image for redaction preview.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setIsUploading(true);
    setError(null);
    try {
      const apiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
      // Ensure we send the original file to the server. The server will perform the actual redaction.
      const buffer = await file.arrayBuffer();
      const res = await fetch(`${apiUrl}/api/v1/cash/request/${tradeId}/evidence`, {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "x-file-name": file.name,
        },
        body: buffer,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Upload failed");
      }

      onUploadSuccess();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div style={{
      backgroundColor: "#1e1e2e",
      color: "#cdd6f4",
      padding: "24px",
      borderRadius: "12px",
      maxWidth: "800px",
      width: "100%",
      maxHeight: "90vh",
      overflowY: "auto",
    }}>
      <h3 style={{ marginTop: 0, color: "#f9e2af" }}>Upload Evidence (Redaction Preview)</h3>

      {!file && (
        <div style={{ marginBottom: "20px" }}>
          <label style={{
            display: "inline-block",
            padding: "10px 20px",
            backgroundColor: "#313244",
            color: "#cdd6f4",
            borderRadius: "6px",
            cursor: "pointer",
            border: "1px solid #45475a",
          }}>
            Select Image
            <input 
              type="file" 
              accept="image/jpeg, image/png, image/webp"
              onChange={handleFileChange} 
              style={{ display: "none" }} 
            />
          </label>
        </div>
      )}

      {file && (
        <div ref={containerRef} style={{ marginBottom: "20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ position: "relative", marginBottom: "16px", maxWidth: "100%", border: "1px solid #45475a", borderRadius: "8px", overflow: "hidden" }}>
            <canvas ref={canvasRef} style={{ maxWidth: "100%", display: "block" }} />
            {isProcessing && (
              <div style={{
                position: "absolute",
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: "rgba(30, 30, 46, 0.7)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#f9e2af",
                fontWeight: "bold"
              }}>
                Scanning for sensitive information...
              </div>
            )}
          </div>

          {!isProcessing && redactionsCount > 0 && (
            <div style={{ color: "#a6e3a1", marginBottom: "16px", fontWeight: "bold" }}>
              ✓ Detected and redacted {redactionsCount} sensitive item(s).
              <div style={{ fontSize: "0.85rem", color: "#a6adc8", fontWeight: "normal", marginTop: "4px" }}>
                Note: Server will strip EXIF data and apply final redactions automatically.
              </div>
            </div>
          )}
          {!isProcessing && redactionsCount === 0 && (
            <div style={{ color: "#a6adc8", marginBottom: "16px" }}>
              No sensitive information detected. 
              <br/>
              <span style={{ fontSize: "0.85rem" }}>Server will strip EXIF data automatically.</span>
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ color: "#f38ba8", padding: "8px", borderRadius: "6px", backgroundColor: "#45475a", marginBottom: "16px" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          disabled={isUploading || isProcessing}
          style={{
            padding: "8px 16px",
            borderRadius: "6px",
            border: "1px solid #45475a",
            backgroundColor: "transparent",
            color: "#cdd6f4",
            cursor: (isUploading || isProcessing) ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
        {file && (
          <button
            onClick={handleUpload}
            disabled={isUploading || isProcessing}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: "#89b4fa",
              color: "#11111b",
              fontWeight: "bold",
              cursor: (isUploading || isProcessing) ? "not-allowed" : "pointer",
            }}
          >
            {isUploading ? "Uploading..." : "Confirm & Upload"}
          </button>
        )}
      </div>
    </div>
  );
}
