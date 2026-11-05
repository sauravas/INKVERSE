import sys, random
sys.path.insert(0, 'backend')
from app.ai.parser import StepStreamParser, events_to_steps

SAMPLE = """@@STEP Identify the parts
We use integration by parts with $u = x^2$ and $dv = e^{3x}dx$.

So $du = 2x\,dx$ and $v = \frac{1}{3}e^{3x}$.
@@STEP Apply the formula
$$
I = \frac{x^2 e^{3x}}{3} - \frac{2}{3}\int x e^{3x}\,dx
$$
Now repeat on the remaining integral.
@@FINAL
$$I = \frac{e^{3x}}{27}\left(9x^2 - 6x + 2\right) + C$$
"""

def run(chunks):
    p = StepStreamParser()
    ev = []
    for c in chunks:
        ev += p.feed(c)
    ev += p.finish()
    return ev

def chunk_random(s, seed):
    r = random.Random(seed); out=[]; i=0
    while i < len(s):
        n = r.randint(1, 7); out.append(s[i:i+n]); i += n
    return out

whole = run([SAMPLE])
print("=== steps from single chunk ===")
for s in events_to_steps(whole):
    print(f"  [{s['index']}] final={s['final']} title={s['title']!r}")
    for seg in s['segments']:
        if seg['kind'] != 'text' or seg['value'].strip():
            print(f"      {seg['kind']:5} disp={int(seg['display'])} {seg['value'][:60]!r}")

print("\n=== streaming stability (random 1-7 char chunks) ===")
ok = True
for seed in range(40):
    got = run(chunk_random(SAMPLE, seed))
    if events_to_steps(got) != events_to_steps(whole):
        ok = False; print("  MISMATCH at seed", seed); break
print("  identical across 40 random chunkings:", ok)

print("\n=== degradation: model ignores the protocol ===")
bad = run(["## Solution\n", "Just **plain** markdown with $x^2$ and no markers.\n"])
for s in events_to_steps(bad):
    print(f"  [{s['index']}] title={s['title']!r}")
    for seg in s['segments']:
        if seg['value'].strip(): print(f"      {seg['kind']:5} {seg['value'][:60]!r}")
