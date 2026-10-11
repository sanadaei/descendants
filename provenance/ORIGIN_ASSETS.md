# Original source assets

This survival / generations build was reconstructed from the three ZIPs supplied at the start of the work. SHA-256 values below were computed from those exact uploaded files before packaging.

| Role | Original ZIP | SHA-256 |
|---|---|---|
| Game/runtime baseline | `DESCENDANTS_HUMAN_TEST_ZONE_PDA_PASS5_I2X_EXTERNAL_BATCH_FACT_VIEW_REVIEW_REPLAN_HANDOFF_2026-09-15(1).zip` | `a80088dabc9c51bffb7c1fde8309e9a0500820849f7151b9b8a6790c0ab11cb6` |
| World generation authority | `DESCENDANTS_V1.0.0_WORLDGEN_1.5_FULL_COMPLETE_2026-09-09.zip` | `0f654ed4d0d34e083ae52c2704ac3662c51b17b092bf77cd8e77f6c9c4f4fb14` |
| Research archive (runtime-disconnected) | `DESCENDANTS_4_INSTANCE_PARALLEL_PROGRESS_PASS22_2026-09-15(1).zip` | `e0ca618517046230e78b1f92faaafde37f916dbed9025c981f96767f27d6810c` |

Authority assignment for this build:
- I2X supplies the playable simulation and ZONE_PDA runtime baseline.
- Worldgen 1.5.0 supplied in the second ZIP is vendored under `vendor/worldgen-engine/` and is the self-contained Worldgen runtime source.
- Pass22 is preserved byte-for-byte at the handoff-file level under `provenance/pass22-original/` and is not imported by production gameplay.
