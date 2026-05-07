"use strict";

const DEFAULT_WATERMARK_TEXT = "https://t.me/AppDoDo/  APPDO数字生活指南";
const MAX_WATERMARK_BYTES = 128;
const MAX_ORIGINAL_SIDE = 4096;
const JPEG_QUALITY = 0.92;
const textEncoder = new TextEncoder();

const state = {
  generatorImage: null,
  generatorName: "image",
  decodeImage: null,
  decodeFile: null,
  decodeName: "image",
  outputBlob: null,
  renderTimer: 0,
  decodeTimer: 0,
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  setupUpload("generatorFile", "generatorDropzone", handleGeneratorFile);
  setupUpload("decodeFile", "decodeDropzone", handleDecodeFile);

  $("watermarkText").value ||= DEFAULT_WATERMARK_TEXT;
  $("decodeExpectedText").value ||= DEFAULT_WATERMARK_TEXT;
  bindRangeValue("hiddenStrength", "hiddenStrengthValue", "");
  bindRangeValue("visibleOpacity", "visibleOpacityValue", "%");
  bindRangeValue("visibleSize", "visibleSizeValue", "%");
  syncWatermarkTextMeta();
  syncDecodeExpectedMeta();

  [
    "hiddenStrength",
    "hiddenMethod",
    "outputMaxSide",
    "snsMode",
    "visibleEnabled",
    "visibleOpacity",
    "visibleSize",
  ].forEach((id) => $(id).addEventListener("input", scheduleGenerate));
  $("watermarkText").addEventListener("input", () => {
    syncWatermarkTextMeta();
    scheduleGenerate();
  });

  ["decodeMethod", "decodeStrength"].forEach((id) => {
    $(id).addEventListener("input", scheduleDecode);
  });
  $("decodeExpectedText").addEventListener("input", () => {
    syncDecodeExpectedMeta();
    scheduleDecode();
  });
  bindRangeValue("decodeStrength", "decodeStrengthValue", "");

  $("generateBtn").addEventListener("click", generateWatermarkedImage);
  $("decodeBtn").addEventListener("click", decodeWatermark);
  $("copyDecodedBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("decodedText").textContent || "");
  });
  $("downloadJpegBtn").addEventListener("click", () => {
    downloadCanvas($("outputCanvas"), `${safeBaseName(state.generatorName)}-appdo-watermarked.jpg`, "image/jpeg");
  });
  $("downloadPngBtn").addEventListener("click", () => {
    downloadCanvas($("outputCanvas"), `${safeBaseName(state.generatorName)}-appdo-watermarked.png`, "image/png");
  });

  setDownloadState(false, false);
});

function setupUpload(inputId, dropzoneId, onFile) {
  const input = $(inputId);
  const dropzone = $(dropzoneId);

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (file) onFile(file);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    });
  });

  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

function bindRangeValue(inputId, outputId, suffix) {
  const input = $(inputId);
  const output = $(outputId);
  const sync = () => {
    output.value = `${input.value}${suffix}`;
  };
  input.addEventListener("input", sync);
  sync();
}

async function handleGeneratorFile(file) {
  try {
    if (!file.type.startsWith("image/")) throw new Error("请选择图片文件。");
    state.generatorImage = await loadImage(file);
    state.generatorName = file.name;
    drawImagePreview(state.generatorImage, $("sourceCanvas"), 900);
    setStatus("generatorStatus", `已载入：${file.name}。正在调用 invisible-watermark 生成...`);
    await generateWatermarkedImage();
  } catch (error) {
    setStatus("generatorStatus", error.message, true);
  }
}

async function handleDecodeFile(file) {
  try {
    if (!file.type.startsWith("image/")) throw new Error("请选择图片文件。");
    state.decodeImage = await loadImage(file);
    state.decodeFile = file;
    state.decodeName = file.name;
    drawImagePreview(state.decodeImage, $("decodeSourceCanvas"), 1200);
    setStatus("decodeStatus", `已载入：${file.name}。正在调用 invisible-watermark 解析...`);
    await decodeWatermark();
  } catch (error) {
    setStatus("decodeStatus", error.message, true);
  }
}

function scheduleGenerate() {
  if (!state.generatorImage) return;
  window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(generateWatermarkedImage, 180);
}

function scheduleDecode() {
  if (!state.decodeImage) return;
  window.clearTimeout(state.decodeTimer);
  state.decodeTimer = window.setTimeout(decodeWatermark, 180);
}

async function generateWatermarkedImage() {
  if (!state.generatorImage) {
    setStatus("generatorStatus", "请先上传图片。", true);
    return;
  }

  setDownloadState(false, null);
  state.outputBlob = null;

  try {
    const preparedBlob = await prepareGeneratorInputBlob();
    const formData = new FormData();
    formData.append("image", preparedBlob, "prepared.png");
    formData.append("watermark_text", getWatermarkText());
    formData.append("method", $("hiddenMethod").value);
    formData.append("scale", $("hiddenStrength").value);
    formData.append("max_side", $("outputMaxSide").value);
    formData.append("sns_mode", $("snsMode").checked ? "true" : "false");

    const response = await fetch("/api/encode", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) throw new Error(await readError(response));

    const outputBlob = await response.blob();
    state.outputBlob = outputBlob;
    await drawBlobToCanvas(outputBlob, $("outputCanvas"));

    const outputSize = response.headers.get("X-Output-Size") || "未知尺寸";
    const method = response.headers.get("X-Watermark-Method") || $("hiddenMethod").value;
    const scale = response.headers.get("X-Watermark-Scale") || $("hiddenStrength").value;
    const watermarkBits = response.headers.get("X-Watermark-Bits") || String(getWatermarkBytes() * 8);
    $("decodeExpectedText").value = getWatermarkText();
    syncDecodeExpectedMeta();
    setStatus(
      "generatorStatus",
      `已使用 ShieldMnt/invisible-watermark 写入自定义暗水印（${watermarkBits} bits）。算法：${method}，scale：${scale}，导出尺寸：${outputSize}。`
    );
    setDownloadState(true, null);
  } catch (error) {
    setStatus("generatorStatus", error.message, true);
    setDownloadState(false, null);
  }
}

async function decodeWatermark() {
  if (!state.decodeImage) {
    setStatus("decodeStatus", "请先上传需要解析的图片。", true);
    return;
  }

  setDownloadState(null, false);
  clearDecodeResult();

  try {
    const file = state.decodeFile;
    if (!file) throw new Error("请重新选择需要解析的图片。");

    const formData = new FormData();
    formData.append("image", file, file.name);
    formData.append("expected_text", getDecodeExpectedText());
    formData.append("method", $("decodeMethod").value);
    formData.append("scale", $("decodeStrength").value);

    const response = await fetch("/api/decode", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) throw new Error(await readError(response));

    const result = await response.json();
    renderDecodeResult(result);
    setStatus(
      "decodeStatus",
      result.exact_match
        ? `解析成功，暗水印内容完整匹配。算法：${result.method}，scale：${result.scale}。`
        : `已完成最佳尝试解析，但未完整匹配。bit 相似度：${Math.round(result.bit_similarity * 100)}%。`
    );
    setDownloadState(null, true);
  } catch (error) {
    setStatus("decodeStatus", error.message, true);
    setDownloadState(null, false);
  }
}

async function prepareGeneratorInputBlob() {
  const canvas = document.createElement("canvas");
  const maxSide = parseOutputMaxSide($("outputMaxSide").value, state.generatorImage);
  const { width, height } = drawImagePreview(state.generatorImage, canvas, maxSide);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  if ($("visibleEnabled").checked) {
    await drawVisibleWatermark(ctx, width, height, {
      opacity: Number($("visibleOpacity").value) / 100,
      sizePercent: Number($("visibleSize").value) / 100,
    });
  }

  return canvasToBlob(canvas, "image/png");
}

function renderDecodeResult(result) {
  $("decodedText").textContent = result.decoded_text || "未读取到可显示文本";
  $("expectedText").textContent = result.expected_text;
  $("decodeMeta").textContent = [
    `完整匹配：${result.exact_match ? "是" : "否"}`,
    `bit 相似度：${Math.round(result.bit_similarity * 100)}%`,
    `byte 相似度：${Math.round(result.byte_similarity * 100)}%`,
    `长度：${result.watermark_bytes} bytes / ${result.watermark_bits} bits`,
    `算法：${result.method}`,
    `scale：${result.scale}`,
  ].join(" · ");
  $("decodeResult").classList.toggle("is-match", result.exact_match);
}

function clearDecodeResult() {
  $("decodedText").textContent = "解析中...";
  $("expectedText").textContent = getDecodeExpectedText();
  $("decodeMeta").textContent = "";
  $("decodeResult").classList.remove("is-match");
}

function getWatermarkText() {
  return $("watermarkText").value.trim();
}

function getDecodeExpectedText() {
  return $("decodeExpectedText").value.trim();
}

function getWatermarkBytes() {
  return utf8ByteLength(getWatermarkText());
}

function syncWatermarkTextMeta() {
  const bytes = getWatermarkBytes();
  $("watermarkTextMeta").textContent = `${bytes}/${MAX_WATERMARK_BYTES} UTF-8 bytes；内容越短，SNS 压缩后越稳。`;
  $("watermarkTextMeta").classList.toggle("is-error", bytes === 0 || bytes > MAX_WATERMARK_BYTES);
}

function syncDecodeExpectedMeta() {
  const bytes = utf8ByteLength(getDecodeExpectedText());
  $("decodeExpectedMeta").textContent = `${bytes}/${MAX_WATERMARK_BYTES} UTF-8 bytes；解析必须知道写入内容的字节长度。`;
  $("decodeExpectedMeta").classList.toggle("is-error", bytes === 0 || bytes > MAX_WATERMARK_BYTES);
}

function utf8ByteLength(value) {
  return textEncoder.encode(value).length;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败。"));
    };
    image.src = url;
  });
}

function drawImagePreview(image, canvas, maxSide) {
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  const size = fitInside(imageWidth, imageHeight, maxSide);
  canvas.width = size.width;
  canvas.height = size.height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.fillStyle = "#fffaf2";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(image, 0, 0, size.width, size.height);

  return size;
}

async function drawBlobToCanvas(blob, canvas) {
  const image = await loadImage(new File([blob], "output.png", { type: blob.type }));
  drawImagePreview(image, canvas, MAX_ORIGINAL_SIDE);
}

function parseOutputMaxSide(value, image) {
  if (value === "original") {
    return Math.min(Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height), MAX_ORIGINAL_SIDE);
  }
  return Math.min(Number(value), MAX_ORIGINAL_SIDE);
}

function fitInside(width, height, maxSide) {
  const safeMaxSide = Math.max(1, Number(maxSide) || MAX_ORIGINAL_SIDE);
  const scale = Math.min(1, safeMaxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function drawVisibleWatermark(ctx, width, height, options) {
  const watermark = await getVisibleWatermarkImage();
  const markWidth = Math.max(96, Math.round(width * options.sizePercent));
  const markHeight = Math.round(markWidth * (watermark.height / watermark.width));
  const spacingX = Math.max(markWidth * 1.7, width * 0.18);
  const spacingY = Math.max(markHeight * 2.25, height * 0.16);

  ctx.save();
  ctx.globalAlpha = options.opacity;
  for (let y = -spacingY; y < height + spacingY; y += spacingY) {
    for (let x = -spacingX; x < width + spacingX; x += spacingX) {
      ctx.save();
      ctx.translate(x + spacingX * 0.52, y + spacingY * 0.5);
      ctx.rotate((-15 * Math.PI) / 180);
      ctx.drawImage(watermark, -markWidth / 2, -markHeight / 2, markWidth, markHeight);
      ctx.restore();
    }
  }
  ctx.restore();
}

let visibleWatermarkPromise = null;

function getVisibleWatermarkImage() {
  if (!visibleWatermarkPromise) {
    visibleWatermarkPromise = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("可视水印素材读取失败。"));
      image.src = "assets/appdo-visible-watermark.svg";
    });
  }
  return visibleWatermarkPromise;
}

function downloadCanvas(canvas, filename, type) {
  if (!canvas.width || !canvas.height) return;
  const quality = type === "image/jpeg" ? JPEG_QUALITY : undefined;
  canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    type,
    quality
  );
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片导出失败。"));
    }, type);
  });
}

async function readError(response) {
  const text = await response.text();
  return text.replace(/<[^>]*>/g, "").trim() || `请求失败：${response.status}`;
}

function setDownloadState(generatorEnabled, decodeEnabled) {
  if (generatorEnabled !== null) {
    $("downloadJpegBtn").disabled = !generatorEnabled;
    $("downloadPngBtn").disabled = !generatorEnabled;
  }
  if (decodeEnabled !== null) {
    $("copyDecodedBtn").disabled = !decodeEnabled;
  }
}

function setStatus(id, text, isError = false) {
  const element = $(id);
  element.textContent = text;
  element.classList.toggle("is-error", isError);
}

function safeBaseName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "-") || "image";
}
