#!/bin/sh

set -eu

image_ref=${1:?image reference is required}
digest_file=${2:?digest output file is required}
image_label=${3:-image}

if push_output=$(docker push "$image_ref" 2>&1); then
  printf '%s\n' "$push_output"
else
  push_status=$?
  printf '%s\n' "$push_output" >&2
  exit "$push_status"
fi

digest=$(
  printf '%s\n' "$push_output" |
    awk '/digest: sha256:/ { for (field = 1; field <= NF; field++) if ($field ~ /^sha256:/) { print $field; exit } }'
)

if ! printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
  printf 'Could not resolve valid pushed %s digest from docker push output\n' "$image_label" >&2
  exit 1
fi

printf '%s\n' "$digest" > "$digest_file"
printf 'Published %s@%s\n' "$image_ref" "$digest"
