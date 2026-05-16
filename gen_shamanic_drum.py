import numpy as np
import wave
import os
import random

SAMPLE_RATE = 44100
DURATION_SECONDS = 30 * 60  # 30 minutes
BPM = 180
OUTPUT_FILE = '/home/user/My_Dashboard/shamanic_drum_30min.wav'
CHUNK_SECONDS = 10


def make_drum_hit(sample_rate, amplitude=0.85, pitch_variation=1.0):
    duration = 0.45
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)

    # Low-frequency pitch sweep (classic hand drum thud)
    freq = np.linspace(120 * pitch_variation, 48 * pitch_variation, len(t))
    tone = np.sin(2 * np.pi * np.cumsum(freq) / sample_rate)

    # Second harmonic for body
    freq2 = freq * 1.5
    tone2 = np.sin(2 * np.pi * np.cumsum(freq2) / sample_rate) * 0.3

    # Noise burst for attack transient
    noise = np.random.normal(0, 1.0, len(t))
    noise_env = np.exp(-t * 60)

    # Main decay envelope
    envelope = np.exp(-t * 9)

    hit = ((tone + tone2) * 0.7 + noise * noise_env * 0.3) * envelope * amplitude
    return hit.astype(np.float32)


def generate(output_file):
    beat_samples = int(60.0 / BPM * SAMPLE_RATE)
    total_samples = DURATION_SECONDS * SAMPLE_RATE
    chunk_size = SAMPLE_RATE * CHUNK_SECONDS

    print(f"Generating {DURATION_SECONDS // 60}-minute shamanic drum at {BPM} BPM...")

    with wave.open(output_file, 'w') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)

        samples_done = 0
        rng = random.Random(42)

        while samples_done < total_samples:
            this_chunk = min(chunk_size, total_samples - samples_done)
            buffer = np.zeros(this_chunk, dtype=np.float32)

            # Place every beat that overlaps this chunk
            start_beat = max(0, samples_done // beat_samples - 1)
            end_beat = (samples_done + this_chunk) // beat_samples + 1

            for beat_idx in range(start_beat, end_beat):
                global_pos = beat_idx * beat_samples
                local_pos = global_pos - samples_done

                # Natural velocity variation (louder accent every 4 beats)
                if beat_idx % 4 == 0:
                    amp = rng.uniform(0.80, 0.95)
                else:
                    amp = rng.uniform(0.50, 0.75)

                # Slight pitch variation for organic feel
                pitch = rng.uniform(0.95, 1.05)

                hit = make_drum_hit(SAMPLE_RATE, amplitude=amp, pitch_variation=pitch)

                h_start = max(0, local_pos)
                h_end = min(this_chunk, local_pos + len(hit))
                if h_end <= h_start:
                    continue
                hit_offset = h_start - local_pos
                buffer[h_start:h_end] += hit[hit_offset: hit_offset + (h_end - h_start)]

            np.clip(buffer, -1.0, 1.0, out=buffer)
            int_buf = (buffer * 32767).astype(np.int16)
            wav.writeframes(int_buf.tobytes())
            samples_done += this_chunk

            mins = samples_done // SAMPLE_RATE // 60
            secs = (samples_done // SAMPLE_RATE) % 60
            print(f"\r  {mins:02d}:{secs:02d} / {DURATION_SECONDS // 60:02d}:00 written...", end='', flush=True)

    size_mb = os.path.getsize(output_file) / (1024 * 1024)
    print(f"\nDone! Saved to: {output_file}  ({size_mb:.1f} MB)")


generate(OUTPUT_FILE)
