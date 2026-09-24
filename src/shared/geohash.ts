const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const REGION_GEOHASH = /^[0-9bcdefghjkmnpqrstuvwxyz]{5}$/;

export const REGION_PRECISION = 5;

export function encodeGeohash(lat: number, lon: number, precision = REGION_PRECISION): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = '';
  let bits = 0;
  let charIndex = 0;
  let isLonBit = true;

  while (hash.length < precision) {
    if (isLonBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        charIndex = (charIndex << 1) | 1;
        lonMin = mid;
      } else {
        charIndex = charIndex << 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        charIndex = (charIndex << 1) | 1;
        latMin = mid;
      } else {
        charIndex = charIndex << 1;
        latMax = mid;
      }
    }
    isLonBit = !isLonBit;
    bits += 1;
    if (bits === 5) {
      hash += BASE32.charAt(charIndex);
      bits = 0;
      charIndex = 0;
    }
  }
  return hash;
}

export function isValidRegionGeohash(value: string): boolean {
  return REGION_GEOHASH.test(value);
}

// Centre of the geohash cell.
export function decodeGeohash(hash: string): { lat: number; lon: number } {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let isLonBit = true;

  for (const char of hash) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error(`invalid geohash character: ${char}`);
    for (let bit = 4; bit >= 0; bit -= 1) {
      const on = ((value >> bit) & 1) === 1;
      if (isLonBit) {
        const mid = (lonMin + lonMax) / 2;
        if (on) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid;
        else latMax = mid;
      }
      isLonBit = !isLonBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}
