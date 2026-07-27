import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../components/LanguageSwitcher.js';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export default function RegisterProvider() {
  const { t } = useTranslation();
  const [stellarAddress, setStellarAddress] = useState('');
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [rate, setRate] = useState('1.0');
  const [availability, setAvailability] = useState<'available' | 'unavailable'>('available');
  const [verificationDocument, setVerificationDocument] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  const handleLocationDetect = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setLat(position.coords.latitude.toString());
          setLng(position.coords.longitude.toString());
        },
        (err) => {
          setError(`${t("register.locationError")}: ${err.message}`);
        }
      );
    } else {
      setError(t("register.geolocationUnsupported"));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedAddress = stellarAddress.trim();
    if (!STELLAR_ADDRESS_REGEX.test(trimmedAddress)) {
      setError(t("register.invalidAddress"));
      return;
    }

    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);
    if (isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90) {
      setError(t("register.invalidLatitude"));
      return;
    }
    if (isNaN(parsedLng) || parsedLng < -180 || parsedLng > 180) {
      setError(t("register.invalidLongitude"));
      return;
    }

    const parsedRate = parseFloat(rate);
    if (isNaN(parsedRate) || parsedRate < 0.01 || parsedRate > 100.0) {
      setError(t("register.invalidRate"));
      return;
    }
    if (!verificationDocument) {
      setError(t("register.verificationDocumentRequired"));
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(verificationDocument.type) || verificationDocument.size > 5 * 1024 * 1024) {
      setError(t("register.invalidVerificationDocument"));
      return;
    }

    setLoading(true);

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5182';
      
      const response = await fetch(`${apiUrl}/api/v1/provider/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          stellar_address: trimmedAddress,
          name: name.trim(),
          lat: parsedLat,
          lng: parsedLng,
          rate: parsedRate,
          availability,
        }),
      });

      if (!response.ok) {
        let errMessage = t("register.registrationFailed");
        try {
          const errData = await response.json();
          errMessage = errData.detail || errData.error || errMessage;
        } catch {
          errMessage = await response.text() || errMessage;
        }
        throw new Error(errMessage);
      }

      const documentResponse = await fetch(`${apiUrl}/api/v1/provider/verification-document`, {
        method: 'POST',
        headers: {
          'Content-Type': verificationDocument.type,
          'x-provider-address': trimmedAddress,
          'x-file-name': verificationDocument.name,
        },
        body: verificationDocument,
      });
      if (!documentResponse.ok) {
        const documentError = await documentResponse.json().catch(() => ({}));
        throw new Error(documentError.error || t("register.documentUploadFailed"));
      }

      setSuccess(true);
      setTimeout(() => navigate('/'), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full text-center space-y-4">
          <h2 className="text-2xl font-bold text-green-600">{t("register.successTitle")}</h2>
          <p className="text-gray-600">{t("register.successDescription")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <LanguageSwitcher />
      <div className="max-w-md w-full space-y-8 bg-white p-8 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h2 className="text-center text-3xl font-extrabold text-gray-900">
            {t("register.title")}
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            {t("register.subtitle")}
          </p>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md">
            {error}
          </div>
        )}

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4 rounded-md shadow-sm">
            <div>
              <label htmlFor="stellarAddress" className="block text-sm font-medium text-gray-700">
                {t("register.stellarAddress")}
              </label>
              <input
                id="stellarAddress"
                name="stellarAddress"
                type="text"
                required
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-400 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono"
                placeholder="G..."
                value={stellarAddress}
                onChange={(e) => setStellarAddress(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                {t("register.businessName")}
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder={t("register.businessNamePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="lat" className="block text-sm font-medium text-gray-700">{t("register.latitude")}</label>
                <input
                  id="lat"
                  name="lat"
                  type="number"
                  step="any"
                  required
                  className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="lng" className="block text-sm font-medium text-gray-700">{t("register.longitude")}</label>
                <input
                  id="lng"
                  name="lng"
                  type="number"
                  step="any"
                  required
                  className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                />
              </div>
            </div>
            
            <button
              type="button"
              onClick={handleLocationDetect}
              className="text-sm text-blue-600 hover:text-blue-500 focus:outline-none"
            >
              {t("register.useCurrentLocation")}
            </button>

            <div>
              <label htmlFor="rate" className="block text-sm font-medium text-gray-700">
                {t("register.exchangeRate")}
              </label>
              <input
                id="rate"
                name="rate"
                type="number"
                step="any"
                required
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder={t("register.exchangeRatePlaceholder")}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="availability" className="block text-sm font-medium text-gray-700">
                {t("register.availability")}
              </label>
              <select
                id="availability"
                name="availability"
                className="mt-1 block w-full pl-3 pr-10 py-2 border border-gray-300 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                value={availability}
                onChange={(e) => setAvailability(e.target.value as 'available' | 'unavailable')}
              >
                <option value="available">{t("register.available")}</option>
                <option value="unavailable">{t("register.unavailable")}</option>
              </select>
            </div>

            <div>
              <label htmlFor="verificationDocument" className="block text-sm font-medium text-gray-700">
                {t("register.verificationDocument")}
              </label>
              <p className="mt-1 text-xs text-gray-500">{t("register.verificationDocumentHelp")}</p>
              <input
                id="verificationDocument"
                name="verificationDocument"
                type="file"
                required
                accept="image/jpeg,image/png,image/webp"
                className="mt-2 block w-full text-sm text-gray-700"
                onChange={(e) => setVerificationDocument(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? t("register.registering") : t("register.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
