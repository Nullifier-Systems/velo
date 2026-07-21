import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const STELLAR_ADDRESS_REGEX = /^G[1-9A-HJ-NP-Za-km-z]{55}$/;

export default function RegisterProvider() {
  const [stellarAddress, setStellarAddress] = useState('');
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [rate, setRate] = useState('1.0');
  const [availability, setAvailability] = useState<'available' | 'unavailable'>('available');
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
          setError('Could not detect location: ' + err.message);
        }
      );
    } else {
      setError('Geolocation is not supported by your browser');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // 1. Validate Stellar Address
    const trimmedAddress = stellarAddress.trim();
    if (!STELLAR_ADDRESS_REGEX.test(trimmedAddress)) {
      setError(
        'Please enter a valid Stellar public address (starts with G and is 56 characters long).'
      );
      return;
    }

    // 2. Validate Coordinates
    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);
    if (isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90) {
      setError('Latitude must be a valid number between -90 and 90.');
      return;
    }
    if (isNaN(parsedLng) || parsedLng < -180 || parsedLng > 180) {
      setError('Longitude must be a valid number between -180 and 180.');
      return;
    }

    // 3. Validate Rate Range
    const parsedRate = parseFloat(rate);
    if (isNaN(parsedRate) || parsedRate < 0.01 || parsedRate > 100.0) {
      setError('Exchange rate must be a reasonable number between 0.01 and 100.0.');
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
        let errMessage = 'Registration failed';
        try {
          const errData = await response.json();
          errMessage = errData.detail || errData.error || errMessage;
        } catch {
          errMessage = (await response.text()) || errMessage;
        }
        throw new Error(errMessage);
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
          <h2 className="text-2xl font-bold text-green-600">Registered Successfully!</h2>
          <p className="text-gray-600">
            Your cash provision location is now active and ready in the table.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8 bg-white p-8 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h2 className="text-center text-3xl font-extrabold text-gray-900">
            Register as a Provider
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Offer cash liquidity to nearby Velo users
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
                Stellar Wallet Address (G...)
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
                Business / Provider Name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Farmacia Guadalupe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="lat" className="block text-sm font-medium text-gray-700">
                  Latitude
                </label>
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
                <label htmlFor="lng" className="block text-sm font-medium text-gray-700">
                  Longitude
                </label>
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
              📍 Use Current Location
            </button>

            <div>
              <label htmlFor="rate" className="block text-sm font-medium text-gray-700">
                Exchange Rate / Fee Multiplier (e.g. 1.0)
              </label>
              <input
                id="rate"
                name="rate"
                type="number"
                step="any"
                required
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="1.0"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="availability" className="block text-sm font-medium text-gray-700">
                Initial Availability Status
              </label>
              <select
                id="availability"
                name="availability"
                className="mt-1 block w-full pl-3 pr-10 py-2 border border-gray-300 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                value={availability}
                onChange={(e) => setAvailability(e.target.value as 'available' | 'unavailable')}
              >
                <option value="available">Available (Active)</option>
                <option value="unavailable">Unavailable (Inactive)</option>
              </select>
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? 'Registering...' : 'Register Provider'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
