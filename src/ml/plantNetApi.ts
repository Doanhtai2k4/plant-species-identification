const PLANTNET_API_KEY = '2b10nMbjESKPkdiR6ScDPqsYu';

type PlantNetResult = {
  score: number;
  species: {
    scientificName?: string;
    scientificNameWithoutAuthor?: string;
    commonNames?: string[];
    family?: {
      scientificName?: string;
    };
    genus?: {
      scientificName?: string;
    };
  };
};

type PlantNetResponse = {
  bestMatch?: string;
  results?: PlantNetResult[];
  remainingIdentificationRequests?: number;
  message?: string;
  error?: string;
};

function toFileUri(filePath: string) {
  return filePath.startsWith('file://') ? filePath : `file://${filePath}`;
}

export async function identifyPlantWithPlantNet(filePath: string) {
  const imageUri = toFileUri(filePath);

  const formData = new FormData();

  formData.append('images', {
    uri: imageUri,
    type: 'image/jpeg',
    name: 'plant.jpg',
  } as any);

  formData.append('organs', 'leaf');

  const url =
    `https://my-api.plantnet.org/v2/identify/all` +
    `?api-key=${PLANTNET_API_KEY}` +
    `&lang=en` +
    `&nb-results=1`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
    },
    body: formData,
  });

  const data = (await response.json()) as PlantNetResponse;

  if (!response.ok) {
    throw new Error(
      data.message || data.error || `PlantNet API lỗi HTTP ${response.status}`,
    );
  }

  const best = data.results?.[0];

  if (!best) {
    return {
      label: data.bestMatch ?? 'Không nhận diện được',
      scientificName: data.bestMatch ?? 'Không rõ',
      commonName: 'Không có tên thường gọi',
      family: 'Không rõ họ',
      genus: 'Không rõ chi',
      confidence: 0,
      confidencePercent: '0.0%',
      remainingRequests: data.remainingIdentificationRequests,
    };
  }

  const scientificName =
    best.species.scientificName ||
    best.species.scientificNameWithoutAuthor ||
    data.bestMatch ||
    'Không rõ';

  const commonName =
    best.species.commonNames && best.species.commonNames.length > 0
      ? best.species.commonNames[0]
      : 'Không có tên thường gọi';

  return {
    label: commonName !== 'Không có tên thường gọi' ? commonName : scientificName,
    scientificName,
    commonName,
    family: best.species.family?.scientificName ?? 'Không rõ họ',
    genus: best.species.genus?.scientificName ?? 'Không rõ chi',
    confidence: best.score,
    confidencePercent: `${(best.score * 100).toFixed(1)}%`,
    remainingRequests: data.remainingIdentificationRequests,
  };
}
