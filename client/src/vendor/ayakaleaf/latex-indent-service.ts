// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) Overleaf, 2014-2025; Pro Authors, 2026-now.
// Vendored verbatim below this notice from AyakaLeaf Pro pro-v6.3.2:
// commit 925980d35f22b89931a28873db38de2d72d35cc6,
// services/web/frontend/js/features/source-editor/languages/latex/latex-indent-service.ts
// See THIRD_PARTY_NOTICES.md. Added provenance notice 2026-11-11; code unchanged.
import { indentService } from '@codemirror/language'

export const latexIndentService = () =>
  indentService.of(indentContext => {
    // only use this for insertNewLineAndIndent
    if (indentContext.simulatedBreak) {
      // match the indentation of the previous line (if present)
      return null
    }
  })
