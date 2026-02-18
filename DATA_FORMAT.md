# Data format for analysis scripts

## Expected CSV format (intraday OHLCV)

One row per candle. Header required. Column names (order can vary if header is used):

| Column   | Description        | Example   |
|----------|--------------------|-----------|
| date     | YYYY-MM-DD         | 2026-02-16 |
| time     | HH:MM or HH:MM:SS  | 11:30     |
| open     | Open price         | 174.5     |
| high     | High price         | 176.2     |
| low      | Low price          | 173.8     |
| close    | Close price        | 175.1     |
| volume   | Volume (optional)  | 125000    |

Alternatively: `timestamp` (ISO or Unix ms) instead of `date` + `time`.

Place CSV files in `data/` (e.g. `data/BHARATSE_2026-02-16.csv`). Scripts read from `data/` or a path you pass.

## After loading (internal)

Scripts work with an array of candles:

```js
{ date, time, open, high, low, close, volume }
// or
{ timestamp, open, high, low, close, volume }
```

Volume defaults to `0` if missing.
