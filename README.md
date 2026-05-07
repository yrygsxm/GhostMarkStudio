# GhostMark Studio

A lightweight web tool for embedding and decoding robust invisible image watermarks with optional visible branding.

轻量 Python 服务 + 前端网页。暗水印底层使用开源项目 [ShieldMnt/invisible-watermark](https://github.com/ShieldMnt/invisible-watermark)，前端负责图片上传、自定义暗水印内容、可选可视透明水印叠加、预览和下载。

## 本地运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

然后打开 `http://localhost:5173`。

## 实现要点

- 暗水印内容可在页面自由填写，后端按 UTF-8 bytes 写入频域水印。
- 默认内容为 `https://t.me/AppDoDo/  APPDO数字生活指南`；当前限制为 128 UTF-8 bytes，内容越短，压缩后越稳。
- 后端调用 `imwatermark.WatermarkEncoder` 和 `imwatermark.WatermarkDecoder`。
- 默认算法为 `dwtDctSvd`。SNS 增强模式会写入亮度+色度通道，并在小图上自动放大到更适合频域水印的尺寸。
- 解析端需要填写写入时的同一段内容，用它确定解码 bit 长度；随后会自动尝试常用算法/scale 组合，并显示完整匹配、bit 相似度和 byte 相似度。
- 可视水印使用 `assets/appdo-visible-watermark.svg`，默认低透明度、小尺寸、斜向平铺。

## 限制

该方案适合人工核验，不是不可破坏的版权 DRM。`invisible-watermark` 官方 README 也说明频域方法对 JPG 压缩、亮度、噪声较稳，但对强缩放、裁切、旋转，以及网页截图/大面积纯色海报不稳定。为了提高 SNS 存活率，推荐导出 1600px 或 2048px JPEG，并保留默认的「SNS 压缩增强」。
