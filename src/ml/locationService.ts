import {PermissionsAndroid, Platform} from 'react-native';
import Geolocation, {
  GeolocationError,
  GeolocationResponse,
} from '@react-native-community/geolocation';

Geolocation.setRNConfiguration({
  skipPermissionRequests: false,
  locationProvider: 'auto',
});

export type TreeLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
  timestamp: number;
  sampleCount: number;
  source: 'fast' | 'improved' | 'fallback';
};

async function requestAndroidLocationPermission() {
  if (Platform.OS !== 'android') {
    return true;
  }

  const result = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  ]);

  const fineGranted =
    result[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
    PermissionsAndroid.RESULTS.GRANTED;

  const coarseGranted =
    result[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] ===
    PermissionsAndroid.RESULTS.GRANTED;

  return fineGranted || coarseGranted;
}

function isValidPosition(position: GeolocationResponse) {
  const {latitude, longitude, accuracy} = position.coords;

  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    typeof accuracy === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Number.isFinite(accuracy)
  );
}

function toTreeLocation(
  position: GeolocationResponse,
  sampleCount: number,
  source: TreeLocation['source'],
): TreeLocation {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    altitude: position.coords.altitude,
    altitudeAccuracy: position.coords.altitudeAccuracy,
    heading: position.coords.heading,
    speed: position.coords.speed,
    timestamp: position.timestamp,
    sampleCount,
    source,
  };
}

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

function getOnePosition(options: {
  enableHighAccuracy: boolean;
  timeout: number;
  maximumAge: number;
}): Promise<GeolocationResponse> {
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      position => {
        if (!isValidPosition(position)) {
          reject(new Error('Vị trí trả về không hợp lệ.'));
          return;
        }

        resolve(position);
      },
      (error: GeolocationError) => {
        reject(error);
      },
      options,
    );
  });
}

function pickBestPosition(samples: GeolocationResponse[]) {
  const validSamples = samples
    .filter(isValidPosition)
    .sort((a, b) => a.coords.accuracy - b.coords.accuracy);

  return validSamples[0] ?? null;
}

export async function getFastCurrentLocation(): Promise<TreeLocation> {
  const hasPermission = await requestAndroidLocationPermission();

  if (!hasPermission) {
    throw new Error('Bạn chưa cấp quyền vị trí cho app.');
  }

  const position = await getOnePosition({
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: 300000,
  });

  console.log('FAST LOCATION:', {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
  });

  return toTreeLocation(position, 1, 'fast');
}

export async function getImprovedCurrentLocation(): Promise<TreeLocation> {
  const hasPermission = await requestAndroidLocationPermission();

  if (!hasPermission) {
    throw new Error('Bạn chưa cấp quyền vị trí cho app.');
  }

  let fallbackPosition: GeolocationResponse | null = null;

  // Lấy tọa độ nền trước, nhưng không dùng nó để đánh lừa là đã cải thiện.
  try {
    fallbackPosition = await getOnePosition({
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000,
    });

    console.log('FALLBACK LOCATION:', {
      lat: fallbackPosition.coords.latitude,
      lng: fallbackPosition.coords.longitude,
      accuracy: fallbackPosition.coords.accuracy,
    });
  } catch (error) {
    console.log('Không lấy được fallback location:', error);
  }

  const gpsSamples: GeolocationResponse[] = [];
const maxSamples = 4;
const delayBetweenSamplesMs = 1200;
const targetAccuracyMeters = 35;

  for (let i = 0; i < maxSamples; i += 1) {
    try {
      const gpsPosition = await getOnePosition({
        enableHighAccuracy: true,
        timeout: 7000,
        maximumAge: 0,
      });

      gpsSamples.push(gpsPosition);

      console.log(`GPS FRESH SAMPLE ${i + 1}:`, {
        lat: gpsPosition.coords.latitude,
        lng: gpsPosition.coords.longitude,
        accuracy: gpsPosition.coords.accuracy,
      });

      if (
        gpsPosition.coords.accuracy > 0 &&
        gpsPosition.coords.accuracy <= targetAccuracyMeters
      ) {
        break;
      }
    } catch (error) {
      console.log(`Lỗi GPS sample ${i + 1}:`, error);
    }

    await sleep(delayBetweenSamplesMs);
  }

  const bestGps = pickBestPosition(gpsSamples);

  if (bestGps) {
    if (
      !fallbackPosition ||
      bestGps.coords.accuracy < fallbackPosition.coords.accuracy
    ) {
      return toTreeLocation(bestGps, gpsSamples.length, 'improved');
    }
  }

  if (fallbackPosition) {
    return toTreeLocation(fallbackPosition, gpsSamples.length, 'fallback');
  }

  throw new Error(
    'Không lấy được vị trí nào. Hãy bật Location, mở Google Maps bắt vị trí rồi thử lại.',
  );
}