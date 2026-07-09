import { defineView, ViewKey } from 'twenty-sdk/define';
import {
  VARIATION_CONFIG_FIELDS,
  VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/objects/variation-config.object';

// Index view for VariationConfig — the admin surface for record variations
// (see design doc). Shows the target object/relation field, the enabled flag,
// and the last sync/error so failures are visible without digging.
export const VARIATION_CONFIG_VIEW_UNIVERSAL_IDENTIFIER =
  '16884c29-2eeb-4616-8c6d-7fb3cd1ab75a';

export default defineView({
  universalIdentifier: VARIATION_CONFIG_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Variations',
  objectUniversalIdentifier: VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
  icon: 'IconGitFork',
  key: ViewKey.INDEX,
  position: 0,
  fields: [
    {
      universalIdentifier: '60c8decf-f5a7-405c-9190-6b99223bf68f',
      fieldMetadataUniversalIdentifier: VARIATION_CONFIG_FIELDS.name,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier: 'ce6ade56-7ac6-41fc-a322-cfa73ca5696f',
      fieldMetadataUniversalIdentifier: VARIATION_CONFIG_FIELDS.targetObject,
      position: 1,
      isVisible: true,
      size: 140,
    },
    {
      universalIdentifier: 'd9bf6542-0f19-44c4-8343-6ae352f3d911',
      fieldMetadataUniversalIdentifier:
        VARIATION_CONFIG_FIELDS.relationFieldName,
      position: 2,
      isVisible: true,
      size: 150,
    },
    {
      universalIdentifier: '94228900-2510-4131-8ab7-1ca649424117',
      fieldMetadataUniversalIdentifier: VARIATION_CONFIG_FIELDS.enabled,
      position: 3,
      isVisible: true,
      size: 90,
    },
    {
      universalIdentifier: '851c81ed-cb56-48cc-9ec5-d3281b55a7fb',
      fieldMetadataUniversalIdentifier: VARIATION_CONFIG_FIELDS.lastSyncedAt,
      position: 4,
      isVisible: true,
      size: 140,
    },
    {
      universalIdentifier: '5fcb7c6a-bda2-4df8-82f2-cc6becdb666f',
      fieldMetadataUniversalIdentifier: VARIATION_CONFIG_FIELDS.lastError,
      position: 5,
      isVisible: true,
      size: 200,
    },
  ],
});
