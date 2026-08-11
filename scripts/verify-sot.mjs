// scripts/verify-sot.mjs
// SOT mismatch guard. Refuses to proceed (exit 1) if any SOT file hash
// differs from the approved manifest. Prints the manifest hash on success.
import { assertSotMatches } from '../src/contracts/sot-binding.js';

const sotDir = new URL('../docs/master-sot/', import.meta.url).pathname;
try {
  const v = await assertSotMatches(sotDir);
  console.log('SOT VERIFY: PASS');
  console.log('manifest_sha256=' + v.manifestHash);
  for (const r of v.results) console.log(`  ${r.ok ? 'OK ' : 'BAD'} ${r.file}`);
} catch (e) {
  console.error('SOT VERIFY: FAIL');
  if (e.name === 'SotMismatchError') {
    for (const r of e.results) {
      if (!r.ok) console.error(`  MISMATCH ${r.file}\n    expected=${r.expected}\n    actual  =${r.actual}`);
    }
  } else {
    console.error(e);
  }
  process.exit(1);
}
