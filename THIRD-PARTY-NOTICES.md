# Third-party attribution notices

This package ships code tables that reference external terminologies. The
notices below are required by those sources and apply in addition to `LICENSE`
(Apache-2.0), which covers this project's own code.

## LOINC (Regenstrief Institute)

This package includes LOINC codes and names in `src/lib/fhir-converter/types.ts`
(`VITAL_LOINC_CODES`) and `src/data/cascade-terminology.json`, both of which ship
compiled in `dist/`. The LOINC license (Section 10) requires the following notice
verbatim:

> This material contains content from LOINC (http://loinc.org). LOINC is
> copyright © Regenstrief Institute, Inc. and the Logical Observation Identifiers
> Names and Codes (LOINC) Committee and is available at no cost under the license
> at http://loinc.org/license. LOINC® is a registered United States trademark of
> Regenstrief Institute, Inc.

LOINC is free for commercial and non-commercial use worldwide under that license.

LOINC codes appearing in test fixtures and in converted pod records are instances
of health data rather than incorporated LOINC content, and Section 8 of the
license does not require a notice for those.

Known gap, tracked rather than hidden: the display strings in `VITAL_LOINC_CODES`
are this project's labels, not verbatim LOINC display names. Section 10(c) asks
that extracted LOINC content carry one of the LOINC display names (fully
specified name, SHORTNAME, LONG_COMMON_NAME, or DisplayName). Replacing them
requires reading the strings from a LOINC release rather than writing them by
hand, so it is filed as follow-up work and not guessed at here.

## SNOMED CT (SNOMED International)

`src/data/cascade-terminology.json` includes four SNOMED CT concept identifiers,
and `VITAL_LOINC_CODES` carries a SNOMED code alongside each vital sign. These
are International Edition identifiers and preferred terms only: no relationships,
hierarchies, refsets, maps, or bulk description sets, which are outside the Global
Patient Set and are not redistributed here.

> This material includes SNOMED Clinical Terms® (SNOMED CT®) concept identifiers
> and terms from the SNOMED CT Global Patient Set, released by SNOMED
> International under Creative Commons Attribution-NoDerivatives 4.0
> (https://creativecommons.org/licenses/by-nd/4.0/). SNOMED and SNOMED CT are
> registered trademarks of SNOMED International.

## RxNorm (U.S. National Library of Medicine)

`src/data/rxnorm-names.json` contains RxCUI-to-ingredient-name pairs drawn only
from `SAB=RXNORM` rows. NLM releases the RxNorm vocabulary itself without
restriction, and the Current Prescribable Content subset is explicitly
license-free.

> This product uses publicly available data courtesy of the U.S. National Library
> of Medicine (NLM), National Institutes of Health, Department of Health and Human
> Services. NLM is not responsible for the product and does not endorse or
> recommend this or any other product.

## ICD-10-CM (CDC / CMS)

ICD-10-CM is a U.S. Government work in the public domain. Reference:
https://www.cms.gov/medicare/coding-billing/icd-10-codes
