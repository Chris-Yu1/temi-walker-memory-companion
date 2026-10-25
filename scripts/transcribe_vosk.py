import json
import sys
import wave
import audioop
import re

from vosk import KaldiRecognizer, Model, SetLogLevel


def main() -> None:
    audio_path, model_path = sys.argv[1], sys.argv[2]
    SetLogLevel(-1)

    with wave.open(audio_path, "rb") as audio:
        if audio.getnchannels() not in (1, 2) or audio.getsampwidth() != 2:
            raise ValueError("Expected mono or stereo 16-bit PCM WAV audio.")

        recognizer = KaldiRecognizer(Model(model_path), audio.getframerate())
        while True:
            data = audio.readframes(4000)
            if not data:
                break
            if audio.getnchannels() == 2:
                data = audioop.tomono(data, 2, 0.5, 0.5)
            recognizer.AcceptWaveform(data)

    result = json.loads(recognizer.FinalResult())
    text = result.get("text", "").strip()
    british_spellings = {
        "color": "colour",
        "favorite": "favourite",
        "center": "centre",
        "theater": "theatre",
        "traveled": "travelled",
        "traveling": "travelling",
        "mom": "mum",
    }
    for american, british in british_spellings.items():
        text = re.sub(rf"\b{american}\b", british, text, flags=re.IGNORECASE)
    print(text)


if __name__ == "__main__":
    main()
