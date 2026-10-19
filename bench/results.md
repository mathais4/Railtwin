# RailTwin benchmark

Node v22.22.0 on Intel(R) Xeon(R) Processor @ 2.10GHz, 2026-10-18. Median of 5 runs after one warm-up.

| Network | Trains | Incidents | Events | Median ms | Events / s | Trains / s | Gridlocked |
|---|---:|---:|---:|---:|---:|---:|:---:|
| 6×6 grid, 60 segments | 250 | 5 | 2,423 | 14.3 | 170,035 | 17,544 | no |
| 10×10 grid, 180 segments | 1000 | 20 | 13,915 | 26.0 | 535,250 | 38,466 | no |
| 14×14 grid, 364 segments | 4000 | 80 | 89,240 | 265.1 | 336,577 | 15,086 | no |
| 20×20 grid, 760 segments | 8000 | 160 | 245,390 | 1280.9 | 191,583 | 6,246 | yes |

## Sample network (47 trains)

| Scenario | Full sim, ms | Optimiser: simulations | Optimiser ms | Passenger-min, no action → optimised |
|---|---:|---:|---:|---|
| Late-running intercity | 1.04 | 22 | 64 | 8,490 → 4,735 |
| Signal failure, Millbrook–Riverside | 0.84 | 154 | 185 | 22,560 → 9,089 |
| Fallen tree on the Lough Arden branch | 0.50 | 12 | 11 | 5,260 → 5,260 |
| Four platforms closed at Riverside Central | 0.99 | 22 | 44 | 297,291 → 544 |
| Morning meltdown | 0.75 | 29 | 33 | 163,950 → 11,120 |
