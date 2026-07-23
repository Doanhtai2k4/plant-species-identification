import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Camera as OcrCamera,
  type Text as OcrText,
} from 'react-native-vision-camera-ocr-plus';
import {
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
const OcrCameraAny = OcrCamera as any;

const scanRegion = {
  left: '18%',
  top: '34%',
  width: '65%',
  height: '20%',
} as const;

const REQUIRED_SCAN_SAMPLES = 10;
const MAX_SCAN_SAMPLES = 20;
const SCAN_SAMPLE_INTERVAL_MS = 600;
const MIN_AUTO_LOCK_DURATION_MS = 4000;

// Ngưỡng "đồng thuận" tính theo TỶ LỆ trên số mẫu hợp lệ, thay vì số đếm cố
// định — để nhất quán dù số mẫu thu được nhiều/ít tuỳ tốc độ camera.
const CODE_AGREEMENT_RATIO = 0.7; // >=70% mẫu phải "gần giống" mã được chọn
const NAME_AGREEMENT_RATIO = 0.6; // >=60% mẫu phải "gần giống" tên được chọn
const MIN_FULL_RESULT_AGREEMENT = 3;

// --- Chốt theo bậc (tiered confidence) ---
// Bậc "rõ ràng": ảnh nét, đọc ổn định ngay từ sớm -> chốt nhanh, không cần
// chờ đủ REQUIRED_SCAN_SAMPLES.
const EARLY_MIN_SAMPLES = 5;
const EARLY_CODE_AGREEMENT_RATIO = 0.85;
const EARLY_NAME_AGREEMENT_RATIO = 0.75;
// Bậc "chấp nhận được": ảnh khó hơn nhưng đã có đủ tín hiệu để không phải
// đoán mò -> chốt sớm hơn hard timeout, với ngưỡng tin cậy thấp hơn.
const SOFT_TIMEOUT_MS = 6500;
const SOFT_MIN_SAMPLES = 6;
const SOFT_CODE_AGREEMENT_RATIO = 0.5;
const SOFT_NAME_AGREEMENT_RATIO = 0.4;

// Khoảng cách Levenshtein tối đa để coi 2 lần đọc TÊN CÂY là "cùng 1 giá
// trị thật" (chấp nhận sai lệch nhỏ do OCR đọc nhầm 1-2 ký tự).
const NAME_FUZZY_DISTANCE = 2;

// Chốt sớm nếu N mẫu liên tiếp (không throttle theo interval) trùng khớp
// gần như tuyệt đối — dùng cho trường hợp bảng rất rõ, đọc ổn định ngay.
const STREAK_LOCK_COUNT = 4;
// Lưới an toàn cuối cùng: quá thời gian này thì vẫn chốt kết quả tốt nhất
// hiện có để tránh treo màn hình vô thời hạn khi bảng mờ/khó đọc.
const SCAN_HARD_TIMEOUT_MS = 9000;

const CODE_LABEL_PATTERN =
  /^\s*(số\s*hiệu|so\s*hieu|mã\s*số|ma\s*so|số|mã|ma|id|code|no|number|stt)\b\s*[:.\-–—]?\s*/i;
const CODE_LABEL_FRAGMENT_PATTERN =
  /\b(số\s*hiệu|so\s*hieu|mã\s*số|ma\s*so|id|code|no|number|stt)\b\s*[:.\-–—]?\s*/i;
const CODE_LABEL_FRAGMENT_GLOBAL_PATTERN =
  /\b(số\s*hiệu|so\s*hieu|mã\s*số|ma\s*so|id|code|no|number|stt)\b\s*[:.\-–—]?\s*/gi;
const NAME_LABEL_PATTERN =
  /^\s*(tên\s*cây|ten\s*cay|tên|ten|cây|cay|tree|name|loài|loai|species)\b\s*[:.\-–—]?\s*/i;
const TEXT_PATTERN = /[A-Za-zÀ-ỹ]/;
const LETTER_PATTERN = /[A-Za-zÀ-ỹ]/g;
const NON_NAME_CHAR_PATTERN = /[^A-Za-zÀ-ỹ\s'.-]/g;

function normalizeOcrLines(rawText: string) {
  return rawText
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[|]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseTreeSign(rawText: string) {
  const lines = normalizeOcrLines(rawText);

  const codeCandidate = findBestCodeCandidate(lines);
  const treeName = findBestTreeName(lines, codeCandidate.lineIndex);

  return {
    rawText,
    lines,
    treeName,
    code: codeCandidate.code,
  };
}

type TreeSignResult = ReturnType<typeof parseTreeSign>;

function findBestCodeCandidate(lines: string[]) {
  let bestLineIndex = -1;
  let bestCode = '';
  let bestScore = 0;

  lines.forEach((line, index) => {
    const code = extractCodeFromLine(line);
    if (!code) {
      return;
    }

    const hasLabel = hasCodeLabel(line);
    const labelBonus = hasLabel ? 45 : 0;
    const letterCount = line.match(LETTER_PATTERN)?.length ?? 0;
    const noisePenalty = hasLabel ? 0 : Math.max(0, letterCount - 6);
    const score = code.length * 12 + labelBonus - noisePenalty * 3;

    if (score > bestScore) {
      bestLineIndex = index;
      bestCode = code;
      bestScore = score;
    }
  });

  return {
    lineIndex: bestLineIndex,
    code: bestCode,
  };
}

function extractCodeFromLine(line: string) {
  const internalCodeLabel = line.match(CODE_LABEL_FRAGMENT_PATTERN);
  const withoutLabel =
    internalCodeLabel?.index !== undefined
      ? line.slice(internalCodeLabel.index + internalCodeLabel[0].length)
      : line.replace(CODE_LABEL_PATTERN, '');

  const hasLabel = hasCodeLabel(line);

  if (!/\d/.test(withoutLabel) && !hasLabel) {
    return '';
  }

  const digitLikeGroups = withoutLabel.toUpperCase().match(/[0-9IL|OSGBZA]+/g);

  return (
    digitLikeGroups
      ?.filter(group => /\d/.test(group) || (hasLabel && group.length >= 2))
      .map(group =>
        group
          .replace(/[IL|]/g, '1')
          .replace(/O/g, '0')
          .replace(/S/g, '5')
          .replace(/G/g, '6')
          .replace(/B/g, '8')
          .replace(/Z/g, '2')
          .replace(/A/g, '4'),
      )
      .join('') ?? ''
  );
}

function findBestTreeName(lines: string[], codeLineIndex: number) {
  let bestName = '';
  let bestScore = 0;

  lines.forEach((line, index) => {
    if (index === codeLineIndex && !hasNameLabel(line)) {
      return;
    }

    const name = cleanTreeNameLine(line);

    if (!TEXT_PATTERN.test(name) || isCodeLikeLine(line)) {
      return;
    }

    const letters = name.match(LETTER_PATTERN)?.length ?? 0;
    const digits = name.replace(/\D/g, '').length;
    const words = normalizeStableValue(name).split(' ').filter(Boolean).length;
    const vietnameseMarks = countVietnameseMarks(name);
    const labelBonus = hasNameLabel(line) ? 35 : 0;
    const noisePenalty = name.match(NON_NAME_CHAR_PATTERN)?.length ?? 0;
    const score =
      letters * 4 +
      words * 6 +
      vietnameseMarks * 8 +
      labelBonus -
      digits * 18 -
      noisePenalty * 10;

    if (score > bestScore) {
      bestName = name;
      bestScore = score;
    }
  });

  return bestName;
}

function cleanTreeNameLine(line: string) {
  return line
    .replace(NAME_LABEL_PATTERN, '')
    .replace(CODE_LABEL_PATTERN, '')
    .replace(CODE_LABEL_FRAGMENT_GLOBAL_PATTERN, ' ')
    .replace(/\d+/g, ' ')
    .replace(NON_NAME_CHAR_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s'.-]+|[\s'.-]+$/g, '')
    .trim();
}

function hasCodeLabel(line: string) {
  return (
    CODE_LABEL_PATTERN.test(line) || CODE_LABEL_FRAGMENT_PATTERN.test(line)
  );
}

function hasNameLabel(line: string) {
  return NAME_LABEL_PATTERN.test(line);
}

function isCodeLikeLine(line: string) {
  const normalized = normalizeStableValue(line);
  return /^(so hieu|so|ma so|ma|id|code|no|number|stt)\b/.test(normalized);
}

function normalizeStableValue(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getStableScanKey(parsed: TreeSignResult) {
  return [
    normalizeStableValue(parsed.treeName),
    normalizeStableValue(parsed.code),
  ].join('|');
}

function hasCompleteTreeSign(parsed: TreeSignResult) {
  return Boolean(parsed.treeName && parsed.code);
}

function countVietnameseMarks(value: string) {
  const accentCount =
    value.normalize('NFD').match(/[\u0300-\u036f]/g)?.length ?? 0;
  const dCount = value.match(/[đĐ]/g)?.length ?? 0;

  return accentCount + dCount;
}

// --- Fuzzy consensus: giúp gộp các lần đọc "gần giống nhau" do OCR nhiễu ---

function levenshteinDistance(a: string, b: string) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prevDiagonal = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prevDiagonal
          : 1 + Math.min(prevDiagonal, dp[j], dp[j - 1]);
      prevDiagonal = temp;
    }
  }

  return dp[n];
}

type FuzzyConsensusOptions = {
  normalize?: (value: string) => string;
  getMaxDistance?: (normalizedValue: string) => number;
  prefer?: (value: string) => number;
};

/**
 * Tìm giá trị "trung tâm" trong tập các lần đọc. Với tên cây, có thể so khớp
 * trên dạng không dấu để gom được các frame OCR lúc có dấu/lúc mất dấu.
 */
function pickFuzzyConsensus(
  values: string[],
  maxDistance: number,
  options: FuzzyConsensusOptions = {},
) {
  const records = values
    .map(value => ({
      value,
      key: options.normalize?.(value) ?? value,
    }))
    .filter(record => record.value && record.key);

  if (records.length === 0) {
    return { value: '', agreement: 0, members: [] as string[] };
  }

  let bestValue = records[0].value;
  let bestAgreement = 0;
  let bestMembers: string[] = [];
  let bestPreference = options.prefer?.(bestValue) ?? bestValue.length;

  records.forEach(candidate => {
    const allowedDistance =
      options.getMaxDistance?.(candidate.key) ?? maxDistance;
    const members = records
      .filter(
        record =>
          levenshteinDistance(candidate.key, record.key) <= allowedDistance,
      )
      .map(record => record.value);
    const preference =
      options.prefer?.(candidate.value) ?? candidate.value.length;

    if (
      members.length > bestAgreement ||
      (members.length === bestAgreement && preference > bestPreference)
    ) {
      bestValue = candidate.value;
      bestAgreement = members.length;
      bestMembers = members;
      bestPreference = preference;
    }
  });

  return { value: bestValue, agreement: bestAgreement, members: bestMembers };
}

/**
 * Với các lần đọc cùng độ dài với giá trị trung tâm, bầu chọn ký tự đúng
 * nhất cho TỪNG vị trí. Nhờ đó có thể khôi phục ra một kết quả chính xác
 * hơn cả từng lần đọc riêng lẻ (ví dụ 1 frame đọc nhầm 1 ký tự vẫn được
 * "sửa" nhờ đa số các frame còn lại đọc đúng ký tự đó).
 */
function reconstructByCharacterVote(
  members: string[],
  referenceLength: number,
) {
  const sameLength = members.filter(v => v.length === referenceLength);
  if (sameLength.length === 0) return '';

  let result = '';
  for (let i = 0; i < referenceLength; i++) {
    const freq = new Map<string, number>();
    sameLength.forEach(v => {
      freq.set(v[i], (freq.get(v[i]) ?? 0) + 1);
    });

    let bestChar = '';
    let bestCount = -1;
    freq.forEach((count, ch) => {
      if (count > bestCount) {
        bestCount = count;
        bestChar = ch;
      }
    });
    result += bestChar;
  }

  return result;
}

function hammingDistance(a: string, b: string) {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}

/**
 * Bầu chọn mã số bằng cách: (1) tìm ĐỘ DÀI phổ biến nhất trong các lần đọc
 * — vì số hiệu thường có số chữ số cố định, các lần đọc bị thiếu/thừa 1
 * chữ số (lỗi OCR phổ biến nhất với dãy số) coi như nhiễu và bị loại khỏi
 * vòng bầu chọn — rồi (2) vote riêng TỪNG chữ số trong nhóm cùng độ dài đó.
 * Cách này đáng tin cậy hơn nhiều so với gộp theo khoảng cách Levenshtein,
 * vốn cho phép chèn/xoá ký tự và dễ làm loãng phiếu bầu với mã số.
 */
function pickCodeConsensus(codes: string[]) {
  const nonEmpty = codes.filter(Boolean);

  if (nonEmpty.length === 0) {
    return { value: '', agreement: 0 };
  }

  const freq = new Map<string, number>();

  nonEmpty.forEach(code => {
    freq.set(code, (freq.get(code) ?? 0) + 1);
  });

  let bestCode = '';
  let bestCount = 0;

  freq.forEach((count, code) => {
    if (
      count > bestCount ||
      (count === bestCount && code.length > bestCode.length)
    ) {
      bestCode = code;
      bestCount = count;
    }
  });

  return {
    value: bestCode,
    agreement: bestCount,
  };
}

function getNameFuzzyDistance(normalizedName: string) {
  return Math.max(
    NAME_FUZZY_DISTANCE,
    Math.min(6, Math.ceil(normalizedName.length * 0.18)),
  );
}

function scoreTreeNameQuality(name: string) {
  const letters = name.match(LETTER_PATTERN)?.length ?? 0;
  const words = normalizeStableValue(name).split(' ').filter(Boolean).length;
  const noise = name.match(NON_NAME_CHAR_PATTERN)?.length ?? 0;

  return letters * 4 + words * 8 + countVietnameseMarks(name) * 6 - noise * 12;
}

function pickBestTreeNameValue(names: string[]) {
  let bestName = '';
  let bestScore = Number.NEGATIVE_INFINITY;

  names.forEach(name => {
    const score = scoreTreeNameQuality(name);

    if (score > bestScore) {
      bestName = name;
      bestScore = score;
    }
  });

  return bestName;
}

/**
 * Tổng hợp kết quả cuối cùng từ toàn bộ mẫu đã thu bằng fuzzy consensus:
 * - Mã số: bầu chọn theo độ dài phổ biến nhất + vote từng chữ số.
 * - Tên cây: gộp theo khoảng cách Levenshtein, lấy giá trị trung tâm.
 * Trả về cả tỉ lệ đồng thuận để quyết định có đủ tin cậy để chốt hay chưa.
 */
function buildConsensusResult(samples: TreeSignResult[]) {
  const codes = samples.map(s => s.code).filter(Boolean);
  const names = samples.map(s => s.treeName).filter(Boolean);

  if (codes.length === 0 || names.length === 0) {
    return {
      result: null as TreeSignResult | null,
      codeRatio: 0,
      nameRatio: 0,
      codeAgreement: 0,
      nameAgreement: 0,
    };
  }

  const codeConsensus = pickCodeConsensus(codes);
  const nameConsensus = pickFuzzyConsensus(names, NAME_FUZZY_DISTANCE, {
    normalize: normalizeStableValue,
    getMaxDistance: getNameFuzzyDistance,
    prefer: scoreTreeNameQuality,
  });

  const finalCode = codeConsensus.value;
  const finalName =
    pickBestTreeNameValue(nameConsensus.members) || nameConsensus.value;

  const representativeSample =
    samples.find(s => s.code === finalCode) ?? samples[samples.length - 1];

  const result: TreeSignResult = {
    rawText: representativeSample.rawText,
    lines: representativeSample.lines,
    treeName: finalName,
    code: finalCode,
  };

  return {
    result,
    codeRatio: codeConsensus.agreement / codes.length,
    nameRatio: nameConsensus.agreement / names.length,
    codeAgreement: codeConsensus.agreement,
    nameAgreement: nameConsensus.agreement,
  };
}

type Props = {
  onBack?: () => void;
};

export default function TreeLabelOcrScreen({ onBack }: Props) {
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();

  const [_ocrText, setOcrText] = useState('');
  const [treeName, setTreeName] = useState('');
  const [treeCode, setTreeCode] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [editedCode, setEditedCode] = useState('');
  const [_lines, setLines] = useState<string[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [scanStatus, setScanStatus] = useState(
    'Căn bảng vào khung rồi bấm Quét bảng',
  );
  const [_candidate, setCandidate] = useState<TreeSignResult | null>(null);
  const [candidateCount, setCandidateCount] = useState(0);

  const sampleBufferRef = useRef<TreeSignResult[]>([]);
  const lastSampleAtRef = useRef(0);
  const scanStartedAtRef = useRef(Date.now());
  const isScanningRef = useRef(false);
  // Theo dõi chuỗi kết quả giống nhau liên tiếp (không throttle theo interval)
  // để có thể chốt kết quả sớm ngay khi ảnh đã nét/ổn định.
  const streakKeyRef = useRef('');
  const streakCountRef = useRef(0);

  const ocrOptions = useMemo(
    () => ({
      language: 'latin',
      frameSkipThreshold: 1,
      useLightweightMode: false,
      scanRegion,
    }),
    [],
  );
  const resetScan = useCallback(() => {
    sampleBufferRef.current = [];
    lastSampleAtRef.current = 0;
    scanStartedAtRef.current = Date.now();
    isScanningRef.current = false;
    streakKeyRef.current = '';
    streakCountRef.current = 0;

    setOcrText('');
    setTreeName('');
    setTreeCode('');
    setLines([]);
    setCandidate(null);
    setCandidateCount(0);
    setIsLocked(false);
    setIsScanning(false);
    setIsEditing(false);
    setScanStatus('Căn bảng vào khung rồi bấm Quét bảng');
  }, []);
  const startManualScan = useCallback(() => {
    sampleBufferRef.current = [];
    lastSampleAtRef.current = 0;
    scanStartedAtRef.current = Date.now();
    isScanningRef.current = true;
    streakKeyRef.current = '';
    streakCountRef.current = 0;

    setOcrText('');
    setTreeName('');
    setTreeCode('');
    setLines([]);
    setCandidate(null);
    setCandidateCount(0);
    setIsLocked(false);
    setIsScanning(true);
    setIsEditing(false);
    setScanStatus('Đang quét... giữ yên bảng trong khung');
  }, []);

  const startEditing = useCallback(() => {
    setEditedName(treeName);
    setEditedCode(treeCode);
    setIsEditing(true);
  }, [treeName, treeCode]);

  const saveEditing = useCallback(() => {
    setTreeName(editedName.trim());
    setTreeCode(editedCode.trim());
    setIsEditing(false);
  }, [editedName, editedCode]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleOcrResult = useCallback((data: string | OcrText) => {
    if (!isScanningRef.current) {
      return;
    }

    const resultText =
      typeof data === 'string' ? data.trim() : data.resultText?.trim() ?? '';

    if (!resultText) {
      return;
    }

    const parsed = parseTreeSign(resultText);

    if (!parsed.treeName && !parsed.code) {
      return;
    }

    setCandidate(parsed);

    if (!hasCompleteTreeSign(parsed)) {
      setCandidateCount(0);
      streakKeyRef.current = '';
      streakCountRef.current = 0;
      setScanStatus('Đang đọc bảng... giữ yên trong khung');
      return;
    }

    const now = Date.now();
    const elapsed = now - scanStartedAtRef.current;
    const lockResult = (result: TreeSignResult, status: string) => {
      isScanningRef.current = false;
      setOcrText(result.rawText);
      setLines(result.lines);
      setTreeName(result.treeName);
      setTreeCode(result.code);
      setCandidate(null);
      setCandidateCount(0);
      setIsScanning(false);
      setIsLocked(true);
      setScanStatus(status);
    };

    // --- Nhánh 1: chốt sớm theo "streak" ---
    // Kiểm tra MỌI frame hợp lệ (không throttle theo SCAN_SAMPLE_INTERVAL_MS)
    // để phát hiện ổn định càng sớm càng tốt. Nếu vài frame liên tiếp
    // cho ra đúng 1 kết quả giống hệt nhau, gần như chắc chắn đó là kết
    // quả đúng, không cần chờ gom đủ 6-10 mẫu rải rác.
    const stableKey = getStableScanKey(parsed);
    if (stableKey === streakKeyRef.current) {
      streakCountRef.current += 1;
    } else {
      streakKeyRef.current = stableKey;
      streakCountRef.current = 1;
    }

    // if (
    //   streakCountRef.current >= STREAK_LOCK_COUNT &&
    //   elapsed >= MIN_AUTO_LOCK_DURATION_MS
    // ) {
    //   lockResult(parsed, 'Đã chốt kết quả OCR');
    //   return;
    // }

    // --- Nhánh 2: gom mẫu (throttled) để vote như trước, làm lưới an toàn ---
    if (now - lastSampleAtRef.current < SCAN_SAMPLE_INTERVAL_MS) {
      return;
    }

    const samples = [...sampleBufferRef.current, parsed].slice(
      -MAX_SCAN_SAMPLES,
    );

    sampleBufferRef.current = samples;
    lastSampleAtRef.current = now;
    setCandidate(parsed);
    setCandidateCount(Math.min(samples.length, REQUIRED_SCAN_SAMPLES));
    setScanStatus('Đang kiểm tra độ ổn định... giữ yên bảng');

    const consensus = buildConsensusResult(samples);

    if (!consensus.result) {
      return;
    }

    const hasScannedLongEnough = elapsed >= MIN_AUTO_LOCK_DURATION_MS;

    // --- Nhánh 2a: chốt nhanh khi kết quả đã rất rõ ràng ---
    // Không cần chờ đủ REQUIRED_SCAN_SAMPLES nếu vài mẫu đầu đã đồng thuận
    // rất cao — bảng rõ nét thường cho tín hiệu này rất sớm.
    const meetsEarlyConfidence =
      samples.length >= EARLY_MIN_SAMPLES &&
      consensus.codeAgreement >= MIN_FULL_RESULT_AGREEMENT &&
      consensus.nameAgreement >= MIN_FULL_RESULT_AGREEMENT &&
      consensus.codeRatio >= EARLY_CODE_AGREEMENT_RATIO &&
      consensus.nameRatio >= EARLY_NAME_AGREEMENT_RATIO;

    if (hasScannedLongEnough && meetsEarlyConfidence) {
      lockResult(consensus.result, 'Đã chốt kết quả OCR');
      return;
    }

    // --- Nhánh 2b: chốt theo chuẩn thông thường ---
    const hasEnoughSamples = samples.length >= REQUIRED_SCAN_SAMPLES;
    const meetsConfidence =
      consensus.codeAgreement >= MIN_FULL_RESULT_AGREEMENT &&
      consensus.nameAgreement >= MIN_FULL_RESULT_AGREEMENT &&
      consensus.codeRatio >= CODE_AGREEMENT_RATIO &&
      consensus.nameRatio >= NAME_AGREEMENT_RATIO;

    if (hasScannedLongEnough && hasEnoughSamples && meetsConfidence) {
      lockResult(consensus.result, 'Đã chốt kết quả OCR');
      return;
    }

    // --- Nhánh 2c: chốt "chấp nhận được" khi đã chờ khá lâu ---
    // Bảng khó đọc hơn (mờ, nghiêng, thiếu sáng) hiếm khi đạt được ngưỡng
    // tin cậy cao trong Nhánh 2b. Thay vì bắt người dùng chờ tới hard
    // timeout, chốt sớm hơn với ngưỡng tin cậy thấp hơn nhưng vẫn có cơ sở
    // (đủ mẫu tối thiểu + đồng thuận rõ hơn 50%).
    const meetsSoftConfidence =
      samples.length >= SOFT_MIN_SAMPLES &&
      consensus.codeAgreement >= MIN_FULL_RESULT_AGREEMENT &&
      consensus.nameAgreement >= MIN_FULL_RESULT_AGREEMENT &&
      consensus.codeRatio >= SOFT_CODE_AGREEMENT_RATIO &&
      consensus.nameRatio >= SOFT_NAME_AGREEMENT_RATIO;

    if (elapsed >= SOFT_TIMEOUT_MS && meetsSoftConfidence) {
      lockResult(consensus.result, 'Đã chốt kết quả OCR (độ tin cậy vừa)');
      return;
    }

    // --- Nhánh 3: hard timeout — luôn trả kết quả trong SCAN_HARD_TIMEOUT_MS ---
    // Chốt kết quả đồng thuận tốt nhất hiện có, dù chưa đạt đủ tỉ lệ tin
    // cậy lý tưởng, để tránh treo màn hình vô thời hạn khi bảng khó đọc.
    if (elapsed >= SCAN_HARD_TIMEOUT_MS) {
      lockResult(consensus.result, 'Đã chốt kết quả OCR (best-effort)');
      return;
    }

    setScanStatus('Đang so sánh thêm để tránh chốt nhầm...');
  }, []);

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerTitle}>Cần quyền camera</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Cấp quyền camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerTitle}>Đang tìm camera...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <OcrCameraAny
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        mode="recognize"
        options={ocrOptions}
        callback={handleOcrResult}
      />

      <View style={styles.header}>
        {onBack && (
          <TouchableOpacity style={styles.backButton} onPress={onBack}>
            <Text style={styles.backButtonText}>← Quay lại</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.title}>Đọc bảng cây</Text>
        <Text style={styles.subtitle}>
          Đưa bảng tên/số hiệu vào đúng khung xanh
        </Text>
      </View>

      <View style={styles.ocrFrame}>
        <Text style={styles.frameText}>
          {isLocked
            ? 'Đã chốt kết quả'
            : isScanning
              ? 'Giữ yên bảng...'
              : 'Căn bảng rồi bấm Quét'}
        </Text>
      </View>

      <View style={styles.resultBox}>
        <Text style={styles.resultTitle}>Kết quả OCR</Text>
        <Text style={[styles.statusText, isLocked && styles.statusLocked]}>
          {scanStatus}
        </Text>

        {/* {!isLocked && (
          <>
            <TouchableOpacity
              style={styles.scanButton}
              onPress={isScanning ? resetScan : startManualScan}>
              <Text style={styles.scanButtonText}>
                {isScanning ? 'Dừng quét' : 'Quét bảng'}
              </Text>
            </TouchableOpacity>
            {candidate ? (
              <View style={styles.candidateBox}>
                <Text style={styles.candidateTitle}>
                  Ứng viên gần nhất ({candidateCount}/{REQUIRED_SCAN_SAMPLES})
                </Text>
                <Text style={styles.candidateText}>
                  Tên cây: {candidate.treeName || '-'}
                </Text>
                <Text style={styles.candidateText}>
                  Số hiệu: {candidate.code || '-'}
                </Text>
                <Text style={styles.candidateRaw}>
                  {candidate.lines.join(' | ')}
                </Text>
                <TouchableOpacity
                  style={styles.quickLockButton}
                  onPress={lockCandidate}
                >
                  <Text style={styles.quickLockButtonText}>
                    Chốt kết quả này
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <Text style={styles.hintText}>
                Chưa thấy đủ tên cây và số hiệu trong khung.
              </Text>
            )}
          </>
        )} */}

        {!isLocked && (
          <>
            <TouchableOpacity
              style={styles.scanButton}
              onPress={isScanning ? resetScan : startManualScan}
            >
              <Text style={styles.scanButtonText}>
                {isScanning ? 'Dừng quét' : 'Quét bảng'}
              </Text>
            </TouchableOpacity>

            <Text style={styles.hintText}>
              {isScanning
                ? `Đang đọc bảng... (${candidateCount}/${REQUIRED_SCAN_SAMPLES})\nGiữ bảng trong khung, kết quả sẽ tự hiện khi ổn định.`
                : 'Căn bảng vào khung xanh rồi bấm Quét bảng.'}
            </Text>
          </>
        )}

        {isLocked && !isEditing && (
          <>
            <Text style={styles.resultText}>
              Tên cây: {treeName || 'Chưa đọc được'}
            </Text>

            <Text style={styles.resultText}>
              Số hiệu: {treeCode || 'Chưa đọc được'}
            </Text>

            {/* <Text style={styles.rawTitle}>Danh sách text:</Text>
            <Text style={styles.rawText}>
              {lines.length > 0 ? lines.join(' | ') : '-'}
            </Text> */}

            {/* <Text style={styles.rawTitle}>Raw text:</Text>
            <Text style={styles.rawText}>{ocrText || '-'}</Text> */}

            <TouchableOpacity style={styles.editButton} onPress={startEditing}>
              <Text style={styles.editButtonText}>Sửa kết quả</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.retryButton} onPress={resetScan}>
              <Text style={styles.retryButtonText}>Quét lại</Text>
            </TouchableOpacity>
          </>
        )}

        {isLocked && isEditing && (
          <>
            <Text style={styles.editLabel}>Tên cây</Text>
            <TextInput
              style={styles.editInput}
              value={editedName}
              onChangeText={setEditedName}
              placeholder="Nhập tên cây"
              placeholderTextColor="#9AB3A5"
            />

            <Text style={styles.editLabel}>Số hiệu</Text>
            <TextInput
              style={styles.editInput}
              value={editedCode}
              onChangeText={setEditedCode}
              placeholder="Nhập số hiệu"
              placeholderTextColor="#9AB3A5"
              keyboardType="number-pad"
            />

            <TouchableOpacity style={styles.editButton} onPress={saveEditing}>
              <Text style={styles.editButtonText}>Lưu chỉnh sửa</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.retryButton}
              onPress={cancelEditing}
            >
              <Text style={styles.retryButtonText}>Huỷ</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scanButton: {
    backgroundColor: '#17A65B',
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  scanButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  center: {
    flex: 1,
    backgroundColor: '#F4FBF6',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  centerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F3D2E',
    marginBottom: 16,
  },
  header: {
    position: 'absolute',
    top: 36,
    left: 20,
    right: 20,
  },
  backButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(15, 61, 46, 0.8)',
    marginBottom: 12,
  },
  backButtonText: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  subtitle: {
    marginTop: 6,
    fontSize: 14,
    color: '#D6F5E3',
  },
  languageRow: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  languageButton: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  languageButtonActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  languageButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  languageButtonTextActive: {
    color: '#0F3D2E',
  },
  ocrFrame: {
    position: 'absolute',
    left: scanRegion.left,
    top: scanRegion.top,
    width: scanRegion.width,
    height: scanRegion.height,
    borderWidth: 3,
    borderColor: '#2ECC71',
    borderRadius: 12,
    backgroundColor: 'rgba(46, 204, 113, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameText: {
    color: '#FFFFFF',
    fontWeight: '800',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  resultBox: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
  },
  resultTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F3D2E',
    marginBottom: 8,
  },
  statusText: {
    fontSize: 13,
    color: '#5E7C6B',
    marginBottom: 10,
  },
  statusLocked: {
    color: '#17A65B',
    fontWeight: '800',
  },
  hintText: {
    fontSize: 13,
    color: '#5E7C6B',
  },
  candidateBox: {
    borderWidth: 1,
    borderColor: '#D7E8DD',
    borderRadius: 12,
    padding: 10,
    backgroundColor: '#F6FBF8',
  },
  candidateTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F3D2E',
    marginBottom: 6,
  },
  candidateText: {
    fontSize: 14,
    color: '#0F3D2E',
    marginBottom: 4,
  },
  candidateRaw: {
    fontSize: 12,
    color: '#5E7C6B',
    marginTop: 4,
  },
  quickLockButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: '#0F3D2E',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  quickLockButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  resultText: {
    fontSize: 16,
    color: '#0F3D2E',
    marginBottom: 6,
  },
  rawTitle: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '800',
    color: '#5E7C6B',
  },
  rawText: {
    fontSize: 13,
    color: '#5E7C6B',
    marginTop: 4,
  },
  button: {
    backgroundColor: '#17A65B',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  retryButton: {
    marginTop: 14,
    backgroundColor: '#17A65B',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  editButton: {
    marginTop: 6,
    backgroundColor: '#0F3D2E',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  editButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  editLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: '#5E7C6B',
    marginTop: 10,
    marginBottom: 4,
  },
  editInput: {
    borderWidth: 1,
    borderColor: '#D7E8DD',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#0F3D2E',
    backgroundColor: '#F6FBF8',
  },
});
