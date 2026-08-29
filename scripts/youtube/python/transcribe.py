#!/usr/bin/env python
"""Local faster-whisper adapter. Emits JSON only; it never writes research files."""
import argparse
import json

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--compute-type")
    parser.add_argument("--language")
    parser.add_argument("--task", choices=("transcribe", "translate"), default="transcribe")
    args = parser.parse_args()

    try:
        import ctranslate2
        cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        cuda = False

    device = ("cuda" if cuda else "cpu") if args.device == "auto" else args.device
    if device == "cuda" and not cuda:
        raise RuntimeError("CUDA was requested, but CTranslate2 detected no CUDA device.")

    multilingual = args.task == "translate" or not args.language or not args.language.lower().startswith("en")
    model_name = args.model or ("large-v3" if device == "cuda" else ("medium" if multilingual else "medium.en"))
    compute_type = args.compute_type or ("float16" if device == "cuda" else "int8")
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        task=args.task,
        word_timestamps=True,
        vad_filter=True,
    )
    output = []
    for index, segment in enumerate(segments, 1):
        words = [
            {
                "start": word.start,
                "end": word.end,
                "text": word.word,
                "probability": word.probability,
            }
            for word in (segment.words or [])
        ]
        probabilities = [word["probability"] for word in words if word["probability"] is not None]
        confidence = sum(probabilities) / len(probabilities) if probabilities else None
        output.append({
            "id": f"whisper:{index:05d}",
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
            "confidence": confidence,
            "words": words,
        })
    print(json.dumps({
        "model": model_name,
        "device": device,
        "computeType": compute_type,
        "language": info.language,
        "languageProbability": info.language_probability,
        "segments": output,
    }))


if __name__ == "__main__":
    main()
