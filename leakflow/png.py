"""零依赖 PNG 编码器（真彩色 / 灰度，8-bit，含 zlib 压缩）。

渗漏现场照片由本模块程序化生成并落盘，避免任何第三方图像库。
标注信息由前端叠层完成，服务端只负责给出原图（保持原比例）。
"""
import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def encode_rgb(width: int, height: int, rows) -> bytes:
    """rows: 可迭代对象，每行是 bytes，长度需为 width*3；每行前置 filter 0。"""
    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit truecolor
    return (
        PNG_SIGNATURE
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )


def make_synthetic_photo(path: str, width: int, height: int,
                         base=(214, 222, 224), stain=(64, 86, 96),
                         spots=((0.42, 0.38, 0.22),), seed: int = 7,
                         title: bytes | None = None):
    """生成一张带水渍纹理的示意图。spots 为归一化圆心与半径的元组列表。"""
    try:
        import random
        rng = random.Random(seed)
    except Exception:
        rng = None

    rows = []
    for y in range(height):
        row = bytearray(width * 3)
        for x in range(width):
            nx, ny = x / width, y / height
            dark = 0.0
            for cx, cy, cr in spots:
                d = ((nx - cx) ** 2 + (ny - cy) ** 2) ** 0.5
                if d < cr:
                    # 边缘柔和、中心最深
                    dark += (1.0 - d / cr) ** 2 * 0.62
            noise = (rng.uniform(-6, 6) if rng else 0)
            # 轻微的纵向水痕
            streak = max(0.0, 0.10 - abs(nx - (spots[0][0] if spots else 0.5))) * \
                     max(0.0, ny - (spots[0][1] if spots else 0.5)) * 0.5
            k = min(0.85, dark + streak)
            i = x * 3
            row[i] = max(0, min(255, int(base[0] + (stain[0] - base[0]) * k + noise)))
            row[i + 1] = max(0, min(255, int(base[1] + (stain[1] - base[1]) * k + noise)))
            row[i + 2] = max(0, min(255, int(base[2] + (stain[2] - base[2]) * k + noise)))
        rows.append(bytes(row))

    if title:
        # 在左上角放一块深色小条（不写字，仅做画面区分标记）
        bar_h, bar_w = 6, min(width - 8, 8 + len(title) * 4)
        for y in range(4, 4 + bar_h):
            for x in range(4, 4 + bar_w):
                i = x * 3
                rows[y] = rows[y][:i] + bytes((40, 48, 52)) + rows[y][i + 3:]

    with open(path, "wb") as f:
        f.write(encode_rgb(width, height, rows))
    return path
