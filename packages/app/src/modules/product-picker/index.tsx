/*
 * ProductPicker module — registers the ProductPicker scaffolder form field (new frontend system) so templates
 * can use `ui:field: ProductPicker`. Used by the New Environment template to make Product a Team-scoped dropdown.
 */
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { FormFieldBlueprint } from '@backstage/plugin-scaffolder-react/alpha';

const productPickerField = FormFieldBlueprint.make({
  name: 'ProductPicker',
  params: {
    field: async () => {
      const [{ createFormField }, { ProductPicker }] = await Promise.all([
        import('@backstage/plugin-scaffolder-react/alpha'),
        import('./ProductPicker'),
      ]);
      return createFormField({
        name: 'ProductPicker',
        component: ProductPicker,
      });
    },
  },
});

export const productPickerModule = createFrontendModule({
  pluginId: 'app',
  extensions: [productPickerField],
});
