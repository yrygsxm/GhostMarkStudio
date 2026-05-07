from __future__ import annotations

import io
import math
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from imwatermark import WatermarkDecoder, WatermarkEncoder
from PIL import Image, ImageOps


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_WATERMARK_TEXT = "https://t.me/AppDoDo/  APPDO数字生活指南"
MAX_WATERMARK_BYTES = 128
MAX_SIDE = 4096
DEFAULT_SCALE = 36
DEFAULT_METHOD = "dwtDctSvd"
JPEG_QUALITY = 92

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024


@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "library": "invisible-watermark",
            "default_watermark_text": DEFAULT_WATERMARK_TEXT,
            "max_watermark_bytes": MAX_WATERMARK_BYTES,
        }
    )


@app.post("/api/encode")
def encode_image():
    upload = request.files.get("image")
    if upload is None:
        abort(400, "missing image file")

    method = normalize_method(request.form.get("method", DEFAULT_METHOD))
    scale = normalize_scale(request.form.get("scale", DEFAULT_SCALE))
    max_side = normalize_max_side(request.form.get("max_side", "2048"))
    sns_mode = request.form.get("sns_mode", "true").lower() == "true"
    _watermark_text, watermark_bytes, watermark_bits = normalize_watermark_text(
        request.form.get("watermark_text", DEFAULT_WATERMARK_TEXT)
    )
    bgr, width, height = load_bgr(upload)

    bgr = resize_for_encode(bgr, max_side=max_side, sns_mode=sns_mode, watermark_bits=watermark_bits)
    ensure_capacity(bgr, sns_mode=sns_mode, watermark_bits=watermark_bits)
    scales = build_scales(scale, sns_mode=sns_mode)

    encoder = WatermarkEncoder()
    encoder.set_watermark("bytes", watermark_bytes)
    encoded = encoder.encode(bgr, method, scales=scales)
    encoded = np.clip(encoded, 0, 255).astype(np.uint8)

    ok, output = cv2.imencode(".png", encoded)
    if not ok:
        abort(500, "failed to encode output image")

    response = send_file(
        io.BytesIO(output.tobytes()),
        mimetype="image/png",
        as_attachment=False,
        download_name="ghostmark-watermarked.png",
    )
    response.headers["X-Watermark-Bits"] = str(watermark_bits)
    response.headers["X-Watermark-Bytes"] = str(len(watermark_bytes))
    response.headers["X-Watermark-Method"] = method
    response.headers["X-Watermark-Scale"] = str(scale)
    response.headers["X-Watermark-Scales"] = ",".join(str(item) for item in scales)
    response.headers["X-Input-Size"] = f"{width}x{height}"
    response.headers["X-Output-Size"] = f"{encoded.shape[1]}x{encoded.shape[0]}"
    return response


@app.post("/api/decode")
def decode_image():
    upload = request.files.get("image")
    if upload is None:
        abort(400, "missing image file")

    preferred_method = request.form.get("method", "auto")
    preferred_scale = normalize_scale(request.form.get("scale", DEFAULT_SCALE))
    expected_text, expected_bytes, expected_bits = normalize_watermark_text(
        request.form.get("expected_text", DEFAULT_WATERMARK_TEXT)
    )
    bgr, width, height = load_bgr(upload)
    best = decode_best_effort(bgr, preferred_method, preferred_scale, expected_bytes)

    return jsonify(
        {
            "decoded_text": best["decoded_text"],
            "expected_text": expected_text,
            "exact_match": best["exact_match"],
            "bit_similarity": best["bit_similarity"],
            "byte_similarity": best["byte_similarity"],
            "method": best["method"],
            "scale": best["scale"],
            "scales": best["scales"],
            "watermark_bits": expected_bits,
            "watermark_bytes": len(expected_bytes),
            "image_size": {"width": width, "height": height},
        }
    )


@app.get("/<path:filename>")
def static_files(filename: str):
    if filename.startswith("api/"):
        abort(404)
    return send_from_directory(BASE_DIR, filename)


def load_bgr(upload) -> tuple[np.ndarray, int, int]:
    raw = upload.read()
    if not raw:
        abort(400, "empty image file")

    try:
        image = Image.open(io.BytesIO(raw))
        image = ImageOps.exif_transpose(image)
        if image.mode in ("RGBA", "LA") or ("transparency" in image.info):
            background = Image.new("RGBA", image.size, (255, 250, 242, 255))
            image = Image.alpha_composite(background, image.convert("RGBA"))
        image = image.convert("RGB")
    except Exception as exc:
        abort(400, f"failed to read image: {exc}")

    rgb = np.array(image)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    height, width = bgr.shape[:2]
    if width < 2 or height < 2:
        abort(400, "image is too small")
    return bgr, width, height


def resize_for_encode(bgr: np.ndarray, max_side: int, sns_mode: bool, watermark_bits: int) -> np.ndarray:
    height, width = bgr.shape[:2]
    long_side = max(width, height)
    capacity = watermark_capacity(width, height, sns_mode=sns_mode)
    target_repeats = 10 if sns_mode else 4
    target_blocks = watermark_bits * target_repeats

    scale = 1.0
    if capacity < target_blocks:
        scale = max(scale, math.sqrt(target_blocks / max(1, capacity)))
    if sns_mode and long_side < 1200:
        scale = max(scale, 1200 / long_side)
    if long_side * scale > max_side:
        scale = max_side / long_side
    if long_side * scale > MAX_SIDE:
        scale = MAX_SIDE / long_side

    if scale == 1.0 and long_side <= max_side and width * height >= 256 * 256:
        return bgr

    new_width = max(320, int(round(width * scale)))
    new_height = max(320, int(round(height * scale)))
    if max(new_width, new_height) > max_side:
        shrink = max_side / max(new_width, new_height)
        new_width = max(320, int(round(new_width * shrink)))
        new_height = max(320, int(round(new_height * shrink)))

    interpolation = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    return cv2.resize(bgr, (new_width, new_height), interpolation=interpolation)


def watermark_capacity(width: int, height: int, sns_mode: bool) -> int:
    active_channels = 2 if sns_mode else 1
    return (width // 16) * (height // 16) * active_channels


def ensure_capacity(bgr: np.ndarray, sns_mode: bool, watermark_bits: int) -> None:
    height, width = bgr.shape[:2]
    capacity = watermark_capacity(width, height, sns_mode=sns_mode)
    if capacity < watermark_bits:
        abort(
            400,
            "watermark text is too long for this image size; shorten the text or increase the output size",
        )


def build_scales(scale: int, sns_mode: bool) -> list[int]:
    if sns_mode:
        return [scale, scale, 0]
    return [0, scale, 0]


def decode_best_effort(bgr: np.ndarray, preferred_method: str, preferred_scale: int, watermark_bytes: bytes) -> dict:
    candidates = []
    methods = ["dwtDct", "dwtDctSvd"] if preferred_method == "auto" else [normalize_method(preferred_method)]
    scales = unique([preferred_scale, DEFAULT_SCALE, 42, 48, 54])
    watermark_bits = len(watermark_bytes) * 8

    for method in methods:
        for scale in scales:
            for scale_vector in ([scale, scale, 0], [0, scale, 0]):
                try:
                    decoder = WatermarkDecoder("bytes", watermark_bits)
                    decoded = decoder.decode(bgr, method, scales=scale_vector)
                    candidates.append(score_candidate(decoded, method, scale, scale_vector, watermark_bytes))
                except Exception as exc:
                    candidates.append(
                        {
                            "decoded_bytes": b"",
                            "decoded_text": f"解码失败：{exc}",
                            "exact_match": False,
                            "bit_similarity": 0.0,
                            "byte_similarity": 0.0,
                            "method": method,
                            "scale": scale,
                            "scales": scale_vector,
                        }
                    )

    return max(candidates, key=lambda item: (item["exact_match"], item["bit_similarity"], item["byte_similarity"]))


def score_candidate(decoded: bytes, method: str, scale: int, scale_vector: list[int], watermark_bytes: bytes) -> dict:
    decoded = bytes(decoded)
    byte_matches = sum(left == right for left, right in zip(decoded, watermark_bytes))
    byte_similarity = byte_matches / len(watermark_bytes)

    expected_bits = np.unpackbits(np.frombuffer(watermark_bytes, dtype=np.uint8))
    decoded_bits = np.unpackbits(np.frombuffer(decoded[: len(watermark_bytes)].ljust(len(watermark_bytes), b"\x00"), dtype=np.uint8))
    bit_similarity = float(np.mean(expected_bits == decoded_bits))

    return {
        "decoded_bytes": decoded,
        "decoded_text": decoded.decode("utf-8", errors="replace"),
        "exact_match": decoded == watermark_bytes,
        "bit_similarity": round(bit_similarity, 4),
        "byte_similarity": round(byte_similarity, 4),
        "method": method,
        "scale": scale,
        "scales": scale_vector,
    }


def normalize_watermark_text(value: str | None) -> tuple[str, bytes, int]:
    text = DEFAULT_WATERMARK_TEXT if value is None else value.strip()
    if not text:
        abort(400, "watermark text is required")

    watermark_bytes = text.encode("utf-8")
    if len(watermark_bytes) > MAX_WATERMARK_BYTES:
        abort(400, f"watermark text is too long; keep it within {MAX_WATERMARK_BYTES} UTF-8 bytes")

    return text, watermark_bytes, len(watermark_bytes) * 8


def normalize_method(value: str) -> str:
    if value not in {"dwtDct", "dwtDctSvd"}:
        abort(400, "method must be dwtDct or dwtDctSvd")
    return value


def normalize_scale(value) -> int:
    try:
        scale = int(float(value))
    except (TypeError, ValueError):
        scale = DEFAULT_SCALE
    return max(18, min(72, scale))


def normalize_max_side(value) -> int:
    if value == "original":
        return MAX_SIDE
    try:
        return max(512, min(MAX_SIDE, int(value)))
    except (TypeError, ValueError):
        return 2048


def unique(values):
    result = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5173, debug=True)
