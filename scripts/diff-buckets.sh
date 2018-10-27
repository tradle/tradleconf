ls_bucket() {
  aws s3 ls "s3://$1" --recursive | awk '{$1=$2=$3=""; print $0}' | sed 's/^[ \t]*//' | sort
}

diff_buckets() {
  local A
  local B
  local aTmp
  local bTmp

  A="$1"
  B="$2"

  # aTmp=$(mktemp)
  aTmp='a.txt'
  ls_bucket "$A" > "$aTmp"

  # bTmp=$(mktemp)
  bTmp='b.txt'
  ls_bucket "$B" > "$bTmp"

  diff "$aTmp" "$bTmp"
}

diff_buckets "$1" "$2"
