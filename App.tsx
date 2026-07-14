import React, { useEffect, useState } from 'react';
import RNFS from 'react-native-fs';
import { identifyPlantWithPlantNet } from './src/ml/plantNetApi';
// import { loadPlantModel, predictPlantFromImageFile } from './src/ml/plantModel';
import {
  ActivityIndicator,
  Image,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0F3D2E" />
      <SafeAreaView style={styles.safeArea}>
        <PlantCameraScreen />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function PlantCameraScreen() {
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const photoOutput = usePhotoOutput();

  const [isCapturing, setIsCapturing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState('Chưa quét cây');
  const [lastPhotoPath, setLastPhotoPath] = useState('');
  const [capturedPhotoUri, setCapturedPhotoUri] = useState('');
  // const [isModelReady, setIsModelReady] = useState(false);
  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // useEffect(() => {
  //   let isMounted = true;

  //   async function preloadModel() {
  //     try {
  //       setResult('Đang tải model AI local...');

  //       await loadPlantModel();

  //       if (isMounted) {
  //         setIsModelReady(true);
  //         setResult('Model AI đã sẵn sàng. Hãy đưa cây vào khung rồi bấm quét.');
  //       }
  //     } catch (error: unknown) {
  //       console.log('Lỗi preload model:', error);

  //       const message =
  //         error instanceof Error ? error.message : JSON.stringify(error);

  //       if (isMounted) {
  //         setResult(`Lỗi tải model: ${message}`);
  //       }
  //     }
  //   }

  //   if (hasPermission) {
  //     preloadModel();
  //   }

  //   return () => {
  //     isMounted = false;
  //   };
  // }, [hasPermission]);

  const handleCapturePhoto = async () => {
    try {
      setIsCapturing(true);
      setCapturedPhotoUri('');
      setLastPhotoPath('');
      setResult('Đang chụp ảnh cây...');

      const photo = await photoOutput.capturePhotoToFile(
        {},
        {
          onDidCapturePhoto: () => {
            console.log('Đã chụp ảnh');
          },
        },
      );

      console.log('Ảnh gốc VisionCamera:', photo.filePath);

      const sourcePath = photo.filePath.replace('file://', '');
      const stablePhotoPath = `${RNFS.DocumentDirectoryPath}/plant_capture_${Date.now()}.jpg`;

      await RNFS.copyFile(sourcePath, stablePhotoPath);

      console.log('Ảnh đã copy sang:', stablePhotoPath);

      setLastPhotoPath(stablePhotoPath);
      setCapturedPhotoUri(`file://${stablePhotoPath}`);

      setResult('Ảnh đã chụp. Nếu góc ổn, bấm Nhận diện cây.');
    } catch (error: unknown) {
      console.log('Lỗi khi chụp ảnh:', error);

      const message =
        error instanceof Error ? error.message : JSON.stringify(error);

      setResult(`Lỗi khi chụp ảnh: ${message}`);
    } finally {
      setIsCapturing(false);
    }
  };

  const handleAnalyzePhoto = async () => {
    try {
      if (!lastPhotoPath) {
        setResult('Bạn cần chụp ảnh trước.');
        return;
      }

      setIsAnalyzing(true);
      setResult('Đang nhận diện cây...');

      // const prediction = await predictPlantFromImageFile(lastPhotoPath);
      const prediction = await identifyPlantWithPlantNet(lastPhotoPath);

      console.log('Kết quả nhận diện:', prediction);

      // if (prediction.confidence < 0.5) {
      //   setResult(
      //     `Model chưa chắc chắn\n` +
      //     `Dự đoán gần nhất: ${prediction.label}\n` +
      //     `Nhóm cây: ${prediction.parentViName}\n` +
      //     `Độ tin cậy: ${prediction.confidencePercent}\n\n` +
      //     `Hãy chụp lá rõ hơn, đủ sáng và để cây chiếm phần lớn khung hình.`,
      //   );
      // } else {
      //   setResult(
      //     `Nhóm cây: ${prediction.parentViName}\n` +
      //     `Chủng loại: ${prediction.label}\n` +
      //     `Độ tin cậy: ${prediction.confidencePercent}`,
      //   );
      // }
      if (prediction.confidence < 0.5) {
        setResult(
          `API chưa chắc chắn\n` +
          `Dự đoán gần nhất: ${prediction.label}\n` +
          `Tên khoa học: ${prediction.scientificName}\n` +
          `Độ tin cậy: ${prediction.confidencePercent}\n\n` +
          `Hãy chụp lá rõ hơn, đủ sáng và để cây chiếm phần lớn khung hình.`,
        );
      } else {
        setResult(
          `Tên cây: ${prediction.label}\n` +
          `Tên khoa học: ${prediction.scientificName}\n` +
          `Họ: ${prediction.family}\n` +
          `Độ tin cậy: ${prediction.confidencePercent}`,
        );
      }
    } catch (error: unknown) {
      console.log('Lỗi khi nhận diện:', error);

      const message =
        error instanceof Error ? error.message : JSON.stringify(error);

      setResult(`Lỗi khi nhận diện: ${message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleRetakePhoto = () => {
    setCapturedPhotoUri('');
    setLastPhotoPath('');
    setResult('Đưa cây vào khung hình rồi bấm Chụp ảnh.');
  };

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.permissionTitle}>Cần quyền camera</Text>
        <Text style={styles.permissionText}>
          Ứng dụng cần camera để quét và nhận diện cây xanh.
        </Text>

        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Cấp quyền camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#17A65B" />
        <Text style={styles.permissionText}>Đang tìm camera sau...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Plant AI Scanner</Text>
        {/* <Text style={styles.subtitle}>Đưa cây vào khung hình rồi bấm quét</Text> */}
        <Text style={styles.subtitle}>Đưa cây vào khung hình rồi bấm Chụp ảnh</Text>
      </View>

      <View style={styles.cameraBox}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={true}
          outputs={[photoOutput]}
        />

        {capturedPhotoUri !== '' && (
          <Image
            source={{ uri: capturedPhotoUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        )}

        <View style={styles.scanFrame} />
      </View>

      <View style={styles.bottomPanel}>
        <Text style={styles.resultTitle}>Kết quả</Text>
        <Text style={styles.resultText}>{result}</Text>

        {lastPhotoPath !== '' && (
          <Text style={styles.photoPath} numberOfLines={1}>
            Ảnh: {lastPhotoPath}
          </Text>
        )}

        {capturedPhotoUri === '' ? (
          <TouchableOpacity
            // style={[
            //   styles.button,
            //   (isCapturing || !isModelReady) && styles.buttonDisabled,
            // ]}
            style={[
              styles.button,
              isCapturing && styles.buttonDisabled,
            ]}
            onPress={handleCapturePhoto}
            // disabled={isCapturing || !isModelReady} 
            disabled={isCapturing}
          >
            <Text style={styles.buttonText}>
              {/* {isCapturing
                ? 'Đang chụp...'
                : !isModelReady
                  ? 'Đang tải model...'
                  : 'Chụp ảnh'} */}
              {isCapturing ? 'Đang chụp...' : 'Chụp ảnh'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton, styles.buttonHalf]}
              onPress={handleRetakePhoto}
              disabled={isAnalyzing}>
              <Text style={styles.secondaryButtonText}>Chụp lại</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.buttonHalf, isAnalyzing && styles.buttonDisabled]}
              onPress={handleAnalyzePhoto}
              disabled={isAnalyzing}>
              <Text style={styles.buttonText}>
                {isAnalyzing ? 'Đang nhận diện...' : 'Nhận diện cây'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0F3D2E',
  },
  container: {
    flex: 1,
    backgroundColor: '#F4FBF6',
  },
  header: {
    paddingVertical: 18,
    paddingHorizontal: 20,
    backgroundColor: '#0F3D2E',
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  subtitle: {
    marginTop: 6,
    fontSize: 14,
    color: '#D6F5E3',
  },
  cameraBox: {
    flex: 1,
    margin: 18,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  scanFrame: {
    position: 'absolute',
    top: '20%',
    left: '12%',
    right: '12%',
    bottom: '20%',
    borderWidth: 3,
    borderColor: '#2ECC71',
    borderRadius: 24,
  },
  bottomPanel: {
    padding: 20,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  resultTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F3D2E',
    marginBottom: 8,
  },
  resultText: {
    fontSize: 15,
    color: '#5E7C6B',
    marginBottom: 10,
    lineHeight: 22,
  },
  photoPath: {
    fontSize: 12,
    color: '#8A9A90',
    marginBottom: 14,
  },
  button: {
    backgroundColor: '#17A65B',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#F4FBF6',
  },
  permissionTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0F3D2E',
    textAlign: 'center',
    marginBottom: 12,
  },
  permissionText: {
    fontSize: 15,
    color: '#5E7C6B',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 20,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  buttonHalf: {
    flex: 1,
  },
  secondaryButton: {
    backgroundColor: '#E8F5EE',
    borderWidth: 1,
    borderColor: '#17A65B',
  },
  secondaryButtonText: {
    color: '#0F3D2E',
    fontSize: 16,
    fontWeight: '800',
  },
});

export default App;
