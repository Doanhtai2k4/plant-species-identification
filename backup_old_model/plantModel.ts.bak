import RNFS from 'react-native-fs';
import * as ort from 'onnxruntime-react-native';
import jpeg from 'jpeg-js';
import {Buffer} from 'buffer';
type PlantLabels = {
  leaf_classes: string[];
  leaf_to_parent: Record<string, string>;
  parent_vi_names: Record<string, string>;
  model_name: string;
  img_size: number;
  input_name: string;
  output_name: string;
  input_shape: number[];
  imagenet_mean: number[];
  imagenet_std: number[];
  best_val_acc?: number;
};

let session: ort.InferenceSession | null = null;
let labels: PlantLabels | null = null;

async function copyModelFromAssets() {
  const modelDestPath = `${RNFS.DocumentDirectoryPath}/plant_model_mobile.onnx`;

  const exists = await RNFS.exists(modelDestPath);

  if (!exists) {
    await RNFS.copyFileAssets('plant_model_mobile.onnx', modelDestPath);
  }

  return modelDestPath;
}

async function loadLabelsFromAssets() {
  const labelsText = await RNFS.readFileAssets('labels_v4.json', 'utf8');
  return JSON.parse(labelsText) as PlantLabels;
}

export async function loadPlantModel() {
  if (session && labels) {
    return { session, labels };
  }

  const modelPath = await copyModelFromAssets();
  labels = await loadLabelsFromAssets();

  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
  });

  return { session, labels };
}

function softmax(logits: Float32Array | number[]) {
  const values = Array.from(logits);
  const maxLogit = Math.max(...values);
  const exps = values.map(x => Math.exp(x - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0);

  return exps.map(x => x / sum);
}

function getTopK(probs: number[], classNames: string[], k = 3) {
  return probs
    .map((prob, index) => ({
      index,
      prob,
      label: classNames[index],
    }))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, k);
}

// Test trước bằng tensor giả để biết model ONNX load và run được chưa.
// Chưa phải nhận diện ảnh thật.
export async function testPlantModelWithDummyInput() {
  const { session: loadedSession, labels: loadedLabels } =
    await loadPlantModel();

  const inputShape = loadedLabels.input_shape;
  const inputSize = inputShape.reduce((a, b) => a * b, 1);

  const dummyData = new Float32Array(inputSize).fill(0);
  const inputTensor = new ort.Tensor('float32', dummyData, inputShape);

  const feeds: Record<string, ort.Tensor> = {
    [loadedLabels.input_name]: inputTensor,
  };

  const output = await loadedSession.run(feeds);

  const logitsTensor = output[loadedLabels.output_name];
  const logits = logitsTensor.data as Float32Array;

  const probs = softmax(logits);
  const top3 = getTopK(probs, loadedLabels.leaf_classes, 3);

  return {
    modelName: loadedLabels.model_name,
    imgSize: loadedLabels.img_size,
    inputShape: loadedLabels.input_shape,
    top3,
  };
}
function resizeCenterCropToCHWFloat32(
  rgba: Uint8Array,
  width: number,
  height: number,
  targetSize: number,
  mean: number[],
  std: number[],
) {
  const output = new Float32Array(1 * 3 * targetSize * targetSize);

  const cropSize = Math.min(width, height);
  const cropX = Math.floor((width - cropSize) / 2);
  const cropY = Math.floor((height - cropSize) / 2);

  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      const srcX = Math.min(
        width - 1,
        cropX + Math.floor((x / targetSize) * cropSize),
      );
      const srcY = Math.min(
        height - 1,
        cropY + Math.floor((y / targetSize) * cropSize),
      );

      const srcIndex = (srcY * width + srcX) * 4;

      const r = rgba[srcIndex] / 255;
      const g = rgba[srcIndex + 1] / 255;
      const b = rgba[srcIndex + 2] / 255;

      const pixelIndex = y * targetSize + x;
      const planeSize = targetSize * targetSize;

      output[pixelIndex] = (r - mean[0]) / std[0];
      output[planeSize + pixelIndex] = (g - mean[1]) / std[1];
      output[2 * planeSize + pixelIndex] = (b - mean[2]) / std[2];
    }
  }

  return output;
}

export async function predictPlantFromImageFile(filePath: string) {
  const {session: loadedSession, labels: loadedLabels} = await loadPlantModel();

  const cleanPath = filePath.replace('file://', '');

  const imageBase64 = await RNFS.readFile(cleanPath, 'base64');
  const imageBuffer = Buffer.from(imageBase64, 'base64');

  const decoded = jpeg.decode(imageBuffer, {
    useTArray: true,
  });

  const imgSize = loadedLabels.img_size;

  const inputData = resizeCenterCropToCHWFloat32(
    decoded.data,
    decoded.width,
    decoded.height,
    imgSize,
    loadedLabels.imagenet_mean,
    loadedLabels.imagenet_std,
  );

  const inputTensor = new ort.Tensor(
    'float32',
    inputData,
    loadedLabels.input_shape,
  );

  const feeds: Record<string, ort.Tensor> = {
    [loadedLabels.input_name]: inputTensor,
  };

  const output = await loadedSession.run(feeds);

  const logitsTensor = output[loadedLabels.output_name];
  const logits = logitsTensor.data as Float32Array;

const probs = softmax(logits);
const top3 = getTopK(probs, loadedLabels.leaf_classes, 3);

const best = top3[0];

const parentKey = loadedLabels.leaf_to_parent[best.label] ?? 'unknown';

const parentViName =
  loadedLabels.parent_vi_names[parentKey] ?? parentKey ?? 'Không rõ nhóm';

return {
  label: best.label,
  confidence: best.prob,
  confidencePercent: `${(best.prob * 100).toFixed(1)}%`,
  parentKey,
  parentViName,
  top3,
};
}