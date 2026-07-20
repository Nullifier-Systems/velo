import { useState, useEffect } from "react";

export type Language = "en" | "es";

export function getBrowserLanguage(): Language {
  const browserLang = navigator.language || (navigator as any).userLanguage || "en";
  return browserLang.toLowerCase().startsWith("es") ? "es" : "en";
}

export function getSavedLanguage(): Language {
  const saved = localStorage.getItem("velo_lang");
  if (saved === "en" || saved === "es") {
    return saved;
  }
  return getBrowserLanguage();
}

export function useLanguage() {
  const [lang, setLang] = useState<Language>(getSavedLanguage);

  const toggleLanguage = () => {
    const nextLang = lang === "en" ? "es" : "en";
    localStorage.setItem("velo_lang", nextLang);
    setLang(nextLang);
    window.dispatchEvent(new Event("velo_lang_change"));
  };

  useEffect(() => {
    const handleSync = () => {
      setLang(getSavedLanguage());
    };
    window.addEventListener("velo_lang_change", handleSync);
    return () => window.removeEventListener("velo_lang_change", handleSync);
  }, []);

  return { lang, toggleLanguage };
}

export const translations = {
  en: {
    // Home Page
    homeSubtitle: "Cash in / cash out — P0 build starts here.",
    homePlaceholder: "Scan a Velo QR code to get started.",
    homeCrashButton: "Simulate Crash",

    // ClaimQR Page
    statusReady: "Ready to claim",
    statusReleased: "Released",
    statusRefunded: "Refunded",
    
    missingId: "This link is missing a claim ID.",
    notFound: "We couldn't find this claim. It may have expired or the link may be incorrect.",
    loadError: "Couldn't load this claim right now. Check your connection and try again.",
    loadingLabel: "Loading your claim",
    qrCodeDescription: "QR code containing the claim instructions and secret for the cash provider to scan.",
    
    amount: "Amount",
    provider: "Provider",
    claimId: "Claim ID",
    
    instructionLocked: "Show this to the cash provider.",
    instructionLockedSub: "They'll scan it to hand you your cash.",
    instructionReleased: "This claim has been completed.",
    instructionReleasedSub: "Funds were released to the provider.",
    instructionRefunded: "This claim was refunded.",
    instructionRefundedSub: "Funds were returned to the sender.",
    
    debugTitle: "Testnet: simulate provider scan",
    debugReleasing: "Releasing…",
    debugButton: "Confirm hand-off (release funds)",
  },
  es: {
    // Home Page
    homeSubtitle: "Depósito / Retiro — El desarrollo P0 empieza aquí.",
    homePlaceholder: "Escanea un código QR de Velo para comenzar.",
    homeCrashButton: "Simular Error",

    // ClaimQR Page
    statusReady: "Listo para cobrar",
    statusReleased: "Entregado",
    statusRefunded: "Reembolsado",
    
    missingId: "Falta el ID de reclamo en este enlace.",
    notFound: "No pudimos encontrar este reclamo. Es posible que haya expirado o que el enlace sea incorrecto.",
    loadError: "No se pudo cargar este reclamo en este momento. Verifique su conexión e intente de nuevo.",
    loadingLabel: "Cargando su reclamo",
    qrCodeDescription: "Código QR que contiene las instrucciones del reclamo y el secreto para que lo escanee el proveedor de efectivo.",
    
    amount: "Monto",
    provider: "Proveedor",
    claimId: "ID de Reclamo",
    
    instructionLocked: "Muestra esto al proveedor de efectivo.",
    instructionLockedSub: "Lo escaneará para entregarte tu efectivo.",
    instructionReleased: "Este reclamo ha sido completado.",
    instructionReleasedSub: "Los fondos fueron liberados al proveedor.",
    instructionRefunded: "Este reclamo fue reembolsado.",
    instructionRefundedSub: "Los fondos fueron devueltos al remitente.",
    
    debugTitle: "Testnet: simular escaneo del proveedor",
    debugReleasing: "Liberando…",
    debugButton: "Confirmar entrega (liberar fondos)",
  }
};
