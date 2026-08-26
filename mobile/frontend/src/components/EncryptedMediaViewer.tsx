import React from "react";
import { useTranslation } from "react-i18next";

interface EncryptedMediaViewerProps {
  dataUrl: string;
  mimeType: string;
}

export const EncryptedMediaViewer: React.FC<EncryptedMediaViewerProps> = ({
  dataUrl,
  mimeType,
}) => {
  const { t } = useTranslation();

  return (
    <div className="relative group rounded-xl overflow-hidden border border-slate-800 bg-slate-950 max-w-sm">
      <img
        src={dataUrl}
        alt={t("e2ee.mediaAlt")}
        className="w-full h-auto object-cover max-h-64 rounded-xl"
      />
      <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-full text-[10px] font-semibold text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
        <span>🔒</span>
        <span>{t("e2ee.encryptedChunkBadge")}</span>
      </div>
    </div>
  );
};
