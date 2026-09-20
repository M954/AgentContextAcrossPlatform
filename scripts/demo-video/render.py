"""Render a local, privacy-redacted screenshot walkthrough. No network services."""

import argparse
import json
import math
import shutil
import subprocess
import textwrap
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


MASKS = {
    "session_share.png": {
        "size": (2688, 424),
        "regions": [
            ((210, 219, 2648, 241), "SESSION IDENTIFIER REDACTED"),
            ((280, 245, 2648, 270), "LOCAL PATH REDACTED"),
            ((50, 271, 2648, 296), "INTERNAL TASK DETAILS REDACTED"),
        ],
    },
    "share_to_target_user.png": {"size": (2725, 243), "regions": []},
    "confirm_information.png": {
        "size": (2707, 421),
        "regions": [
            ((182, 98, 2670, 121), "REVIEW DIGEST REDACTED"),
            ((292, 123, 2670, 149), "LOCAL PREVIEW PATH REDACTED"),
            ((22, 150, 2670, 176), "SOURCE IDENTIFIERS AND TASK TITLE REDACTED"),
        ],
    },
    "locally_share_snapshot.png": {
        "size": (2677, 229),
        "regions": [
            ((211, 73, 2640, 95), "SNAPSHOT IDENTIFIER REDACTED"),
            ((201, 98, 2640, 126), "LOCALHOST LINK - SNAPSHOT IDENTIFIER REDACTED"),
            ((223, 151, 2640, 174), "BUNDLE DIGEST REDACTED"),
        ],
    },
    "session_resume.png": {
        "size": (2695, 289),
        "regions": [
            ((150, 130, 2655, 158), "LOCAL SNAPSHOT LINK REDACTED"),
            ((259, 208, 2655, 234), "RECIPIENT WORKSPACE PATH REDACTED"),
        ],
    },
    "session_restore_finish.png": {
        "size": (2685, 222),
        "regions": [
            ((176, 60, 2645, 85), "INTERNAL DATASET NAME REDACTED"),
            ((215, 86, 2645, 111), "DATASET IDENTIFIER REDACTED"),
            ((180, 112, 2645, 140), "INTERNAL USAGE METRICS REDACTED"),
            ((559, 186, 730, 219), "REDACTED"),
        ],
    },
}

NAVY = (12, 22, 40)
INK = (236, 244, 253)
MUTED = (169, 189, 213)
TEAL = (74, 222, 194)
BLUE = (78, 145, 255)
CARD = (24, 40, 63)


def font(size, bold=False):
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    return ImageFont.truetype(str(Path("C:\\Windows\\Fonts") / name), size)


def wrap(draw, text, face, width):
    output = []
    for paragraph in str(text).split("\n"):
        line = ""
        for word in paragraph.split():
            candidate = f"{line} {word}".strip()
            if line and draw.textlength(candidate, font=face) > width:
                output.append(line)
                line = word
            else:
                line = candidate
        output.append(line)
    return output


def block(draw, text, xy, size, color=INK, width=1700, bold=False, spacing=1.28):
    face = font(size, bold)
    x, y = xy
    lines = wrap(draw, text, face, width)
    for line in lines:
        draw.text((x, y), line, font=face, fill=color)
        y += int(size * spacing)
    return y


def background(width, height):
    image = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / height
        draw.line((0, y, width, y), fill=(int(12 + ratio * 5), int(22 + ratio * 11), int(40 + ratio * 17)))
    draw.rectangle((0, 0, width, 7), fill=TEAL)
    return image


def sanitize(inputs, output):
    output.mkdir(parents=True, exist_ok=True)
    selected = {p.name: p for p in inputs}
    if len(inputs) != len(selected) or set(selected) != set(MASKS):
        raise ValueError("Supply exactly the six named screenshots; no directory scanning is performed.")
    report = []
    for name, spec in MASKS.items():
        if selected[name].resolve() == (output / name).resolve():
            raise ValueError("Refusing to overwrite an original screenshot.")
        with Image.open(selected[name]) as original:
            if original.size != spec["size"]:
                raise ValueError(f"{name}: dimensions changed; review redaction regions before processing.")
            image = Image.new("RGB", original.size, "white")
            image.paste(original.convert("RGB"))
        draw = ImageDraw.Draw(image)
        for rectangle, label in spec["regions"]:
            draw.rectangle(rectangle, fill=(229, 234, 240))
            draw.text((rectangle[0] + 7, rectangle[1] + 2), f"[{label}]", fill=(64, 78, 95), font=font(16, True))
        image.save(output / name, "PNG", optimize=True)
        report.append({"file": name, "dimensions": list(image.size), "redactedRegions": len(spec["regions"])})
    (output / "redactions.json").write_text(json.dumps({
        "note": "Opaque masks applied to publication copies. Original images are unchanged. No original paths or image metadata retained.",
        "images": report,
    }, indent=2), encoding="utf-8")
    contact_sheet(output, output / "contact-sheet.jpg", list(MASKS), screenshots=True)


def contact_sheet(directory, output, names, screenshots=False):
    tile_width = 1100 if screenshots else 640
    tile_height = 300 if screenshots else 400
    columns = 1 if screenshots else 3
    rows = math.ceil(len(names) / columns)
    canvas = Image.new("RGB", (tile_width * columns, tile_height * rows), (225, 232, 241))
    draw = ImageDraw.Draw(canvas)
    for index, name in enumerate(names):
        x = (index % columns) * tile_width
        y = (index // columns) * tile_height
        draw.text((x + 12, y + 8), name, font=font(20, True), fill=NAVY)
        with Image.open(directory / name) as image:
            image = ImageOps.contain(image.convert("RGB"), (tile_width - 24, tile_height - 50))
            canvas.paste(image, (x + 12, y + 42))
    canvas.save(output, "JPEG", quality=92)


def draw_frame(scene, assets, width, height, number, total):
    image = background(width, height)
    draw = ImageDraw.Draw(image)
    kind = scene["kind"]
    block(draw, scene["eyebrow"], (86, 42), 24, TEAL, bold=True)
    title_size = 69 if kind == "title" else 49
    block(draw, scene["title"], (82, 95), title_size, width=1750, bold=True)
    subtitle_y = 295 if kind == "title" else 170
    block(draw, scene["subtitle"], (86, subtitle_y), 29, MUTED, width=1740)
    if kind == "title":
        draw.rounded_rectangle((86, 432, 1834, 758), radius=24, fill=CARD)
        block(draw, "Capture context  ->  Review  ->  Share  ->  Resume", (128, 477), 42, width=1640, bold=True)
        block(draw, "Local proof of concept\nA snapshot of work - not a transfer of credentials or runtime state", (128, 571), 34, MUTED, width=1640)
    elif kind == "cards":
        cards = scene["cards"]
        gap = 24
        card_width = (1748 - gap * (len(cards) - 1)) // len(cards)
        for index, (heading, text) in enumerate(cards):
            x = 86 + index * (card_width + gap)
            draw.rounded_rectangle((x, 300, x + card_width, 775), radius=20, fill=CARD)
            draw.rounded_rectangle((x + 27, 331, x + 80, 384), radius=12, fill=TEAL)
            draw.text((x + 45, 337), str(index + 1), font=font(26, True), fill=NAVY)
            block(draw, heading, (x + 28, 429), 34, width=card_width - 56, bold=True)
            block(draw, text, (x + 28, 526), 29, MUTED, width=card_width - 56, spacing=1.5)
    elif kind == "flow":
        for index, label in enumerate(scene["steps"]):
            x = 86 + index * 450
            draw.rounded_rectangle((x, 336, x + 398, 612), radius=22, fill=CARD, outline=BLUE, width=2)
            block(draw, f"0{index + 1}", (x + 28, 368), 28, TEAL, bold=True)
            block(draw, label, (x + 28, 429), 39, width=350, bold=True)
            if index < 3:
                draw.line((x + 412, 469, x + 440, 469), fill=TEAL, width=4)
                draw.polygon([(x + 440, 469), (x + 427, 458), (x + 427, 480)], fill=TEAL)
        block(draw, "Loopback storage  |  Private local artifacts  |  No automatic replay", (86, 680), 31, MUTED)
        block(draw, "LOCAL ENDPOINT:  http://127.0.0.1:8787", (86, 755), 28, TEAL, bold=True)
    elif kind == "screenshot":
        box = (86, 247, 1834, 785)
        draw.rounded_rectangle(box, radius=20, fill=(255, 255, 255))
        with Image.open(assets / scene["image"]) as original:
            crop = original.crop(tuple(scene["crop"])).convert("RGB")
            crop = ImageOps.contain(crop, (1714, 498), method=Image.Resampling.LANCZOS)
            image.paste(crop, (103, 267 + (498 - crop.height) // 2))
        block(draw, "User-supplied screenshot - privacy-redacted excerpt", (94, 807), 22, MUTED)
        for index, label in enumerate(["SHARE", "AUDIENCE", "REVIEW", "LOCAL LINK", "RESUME", "CONTINUE"], 1):
            x = 91 + (index - 1) * 288
            color = TEAL if index == scene["step"] else MUTED
            block(draw, f"{index:02d}  {label}", (x, 867), 21, color, bold=index == scene["step"])
    elif kind == "team":
        draw.rounded_rectangle((86, 313, 1834, 783), radius=24, fill=CARD)
        block(draw, "Haowen Feng", (134, 366), 58, bold=True)
        block(draw, "Qinqi Xu", (134, 463), 58, bold=True)
        block(draw, "Contact either team member to collaborate.", (136, 578), 34, MUTED)
        block(draw, "github.com/M954/AgentContextAcrossPlatform", (136, 670), 30, TEAL)
        block(draw, "Offline synthetic narration. Redacted screenshots; not a live screen recording.", (91, 833), 22, MUTED)
    else:
        raise ValueError(f"Unsupported scene kind: {kind}")
    draw.rounded_rectangle((86, 934, 1834, 1024), radius=15, fill=(7, 15, 29))
    caption_lines = wrap(draw, scene["caption"], font(27), 1660)
    if len(caption_lines) > 2:
        raise ValueError(f"{scene['id']}: caption is too long")
    block(draw, scene["caption"], (119, 945 if len(caption_lines) == 2 else 960), 27, width=1660)
    block(draw, "LOCAL DEMO" if kind != "cards" or scene["id"] != "11-roadmap" else "FUTURE ROLLOUT",
          (89, 1040), 17, MUTED)
    draw.text((1750, 1040), f"{number:02d} / {total:02d}", font=font(17), fill=MUTED)
    return image


def duration(wav):
    with wave.open(str(wav), "rb") as stream:
        return stream.getnframes() / stream.getframerate()


def timestamp(seconds):
    total = round(seconds * 1000)
    hours, total = divmod(total, 3600000)
    minutes, total = divmod(total, 60000)
    seconds, millis = divmod(total, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def run(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-6000:])


def render(plan_path, assets, work, output, frames_only=False):
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    identifiers = [scene["id"] for scene in plan["scenes"]]
    if len(identifiers) != len(set(identifiers)) or any(
        not name or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in name)
        for name in identifiers
    ):
        raise ValueError("Scene identifiers must be unique safe filenames.")
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    frames = work / "frames"
    frames.mkdir(exist_ok=True)
    names = []
    for index, scene in enumerate(plan["scenes"], 1):
        name = f"{scene['id']}.png"
        draw_frame(scene, assets, plan["width"], plan["height"], index, len(plan["scenes"])).save(frames / name)
        names.append(name)
    contact_sheet(frames, work / "storyboard-contact-sheet.jpg", names)
    shutil.copyfile(frames / names[0], output / "poster.png")
    if frames_only:
        return
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg must be installed locally.")
    clips = work / "clips"
    clips.mkdir(exist_ok=True)
    subtitles = []
    elapsed = 0
    scene_report = []
    for index, scene in enumerate(plan["scenes"], 1):
        wav = work / "audio" / f"{scene['id']}.wav"
        audio_seconds = duration(wav)
        seconds = math.ceil(max(scene["minimumSeconds"], audio_seconds + 0.8) * plan["fps"]) / plan["fps"]
        clip = clips / f"{scene['id']}.mp4"
        run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", str(plan["fps"]),
             "-i", str(frames / f"{scene['id']}.png"), "-i", str(wav), "-t", f"{seconds:.4f}",
             "-vf", f"fade=t=in:st=0:d=0.3,fade=t=out:st={seconds-0.3:.4f}:d=0.3,format=yuv420p",
             "-af", "apad", "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-threads", "2",
             "-c:a", "aac", "-ar", "48000", "-b:a", "128k", "-movflags", "+faststart", str(clip)])
        subtitles.append(f"{index}\n{timestamp(elapsed)} --> {timestamp(elapsed + seconds)}\n" +
                         "\n".join(textwrap.wrap(scene["narration"], width=82)) + "\n")
        scene_report.append({"id": scene["id"], "startSeconds": round(elapsed, 3),
                             "durationSeconds": seconds, "audioSeconds": audio_seconds})
        elapsed += seconds
        print(f"Rendered {index}/{len(plan['scenes'])}: {scene['id']}", flush=True)
    concat = work / "clips.txt"
    concat.write_text("\n".join(f"file 'clips/{scene['id']}.mp4'" for scene in plan["scenes"]), encoding="utf-8")
    video = output / "local-session-handoff-demo.mp4"
    run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
         "-i", str(concat), "-c", "copy", "-movflags", "+faststart", str(video)])
    (output / "local-session-handoff-demo.srt").write_text("\n".join(subtitles), encoding="utf-8")
    (output / "media-info.json").write_text(json.dumps({
        "title": plan["title"], "width": plan["width"], "height": plan["height"], "fps": plan["fps"],
        "durationSeconds": round(elapsed, 3), "narration": "Offline Windows speech synthesis",
        "source": "Six user-provided, privacy-redacted screenshots; not live screen recording",
        "scenes": scene_report,
    }, indent=2), encoding="utf-8")
    print(f"Video ready: {elapsed:.1f}s, {video.stat().st_size / 1024 / 1024:.1f} MiB", flush=True)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    clean = commands.add_parser("sanitize")
    clean.add_argument("--inputs", type=Path, nargs="+", required=True)
    clean.add_argument("--output", type=Path, required=True)
    video = commands.add_parser("render")
    video.add_argument("--storyboard", type=Path, required=True)
    video.add_argument("--assets", type=Path, required=True)
    video.add_argument("--work", type=Path, required=True)
    video.add_argument("--output", type=Path, required=True)
    video.add_argument("--frames-only", action="store_true")
    args = parser.parse_args()
    if args.command == "sanitize":
        sanitize(args.inputs, args.output)
    else:
        render(args.storyboard, args.assets, args.work, args.output, args.frames_only)


if __name__ == "__main__":
    main()
