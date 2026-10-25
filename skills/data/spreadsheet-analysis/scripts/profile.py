#!/usr/bin/env python3
"""Quick profile of a tabular file: python profile.py data.csv [--sheet NAME] [--sep ';']"""
import argparse
import sys

try:
    import pandas as pd
except ImportError:  # pragma: no cover
    sys.exit("pandas is required: pip install pandas openpyxl pyarrow")


def load(path: str, sheet: str | None, sep: str | None) -> "pd.DataFrame":
    low = path.lower()
    if low.endswith((".xlsx", ".xlsm", ".xls")):
        return pd.read_excel(path, sheet_name=sheet or 0)
    if low.endswith(".parquet"):
        return pd.read_parquet(path)
    if low.endswith(".json"):
        return pd.read_json(path)
    return pd.read_csv(path, sep=sep or None, engine="python")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--sheet")
    ap.add_argument("--sep")
    a = ap.parse_args()
    df = load(a.path, a.sheet, a.sep)
    pd.set_option("display.width", 160, "display.max_columns", 50)
    print(f"shape: {df.shape[0]} rows x {df.shape[1]} cols")
    print(f"duplicate rows: {int(df.duplicated().sum())}")
    print("\ncolumns:")
    for col in df.columns:
        s = df[col]
        nulls = s.isna().mean() * 100
        distinct = s.nunique(dropna=True)
        hints = []
        if not pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_datetime64_any_dtype(s):
            sample = s.dropna().head(200).astype(str)
            numeric = pd.to_numeric(sample.str.replace(r"[,\s%$€₺]", "", regex=True), errors="coerce")
            if len(sample) and numeric.notna().mean() > 0.9:
                hints.append("numeric stored as text")
            elif len(sample) and pd.to_datetime(sample, errors="coerce", format="mixed").notna().mean() > 0.9:
                hints.append("looks like dates")
        if distinct == len(s) and nulls == 0 and len(s) > 1:
            hints.append("unique (candidate key)")
        hint = f"  <- {', '.join(hints)}" if hints else ""
        print(f"  {str(col)[:40]:40} {str(s.dtype):12} nulls {nulls:5.1f}%  distinct {distinct:<8}{hint}")
    num = df.select_dtypes("number")
    if not num.empty:
        print("\nnumeric summary:")
        print(num.describe().T.round(3).to_string())
    obj = df.select_dtypes(exclude="number")
    for col in list(obj.columns)[:12]:
        top = obj[col].value_counts(dropna=True).head(5)
        if len(top):
            print(f"\ntop values · {col}:")
            print(top.to_string())
    print("\nhead:")
    print(df.head(5).to_string())


if __name__ == "__main__":
    main()
