/*
 * ProductPicker — a scaffolder form field that turns the "Product" input on the New Environment form into a
 * dropdown auto-populated with ONLY the Products owned by the Team selected earlier in the same form. Products
 * are projected as catalog `System` entities owned by `group:<team>` (platform-projection), so we query the
 * catalog for that team's Systems and recover each Product's short name (the System is named `<team>-<short>`,
 * which is the value the gitops/environments claim expects). Reads the live `team` value from the RJSF
 * formContext — the stock EntityPicker can't do this cross-field filtering, which is why this exists.
 */
import { useEffect, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { TextField, MenuItem } from '@material-ui/core';
import { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';

const asTeamRef = (value: string) =>
  parseEntityRef(value, { defaultKind: 'group', defaultNamespace: 'default' });

export const ProductPicker = (props: FieldExtensionComponentProps<string>) => {
  const { onChange, formData, formContext, rawErrors, required, idSchema, schema } =
    props as FieldExtensionComponentProps<string> & {
      formContext?: { formData?: { team?: string } };
    };
  const catalogApi = useApi(catalogApiRef);
  const team = formContext?.formData?.team;

  const [products, setProducts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    if (!team) {
      setProducts([]);
      return undefined;
    }
    setLoading(true);
    setError(undefined);

    const teamEntity = asTeamRef(team);
    const teamRef = stringifyEntityRef(teamEntity);
    const teamName = teamEntity.name;

    catalogApi
      .getEntities({
        filter: { kind: 'System' },
        fields: ['kind', 'metadata.name', 'spec.owner', 'relations'],
      })
      .then(({ items }) => {
        if (cancelled) return;
        const owned = items.filter(e => {
          const byRelation = (e.relations ?? []).some(
            r =>
              r.type === 'ownedBy' &&
              stringifyEntityRef(parseEntityRef(r.targetRef)) === teamRef,
          );
          const owner = (e.spec as { owner?: string } | undefined)?.owner;
          const byOwner = owner
            ? stringifyEntityRef(asTeamRef(owner)) === teamRef
            : false;
          return byRelation || byOwner;
        });
        // The System is named `<team>-<short>`; the claim wants the short Product name.
        const shorts = owned
          .map(e =>
            e.metadata.name.startsWith(`${teamName}-`)
              ? e.metadata.name.slice(teamName.length + 1)
              : e.metadata.name,
          )
          .sort();
        setProducts(shorts);
        // Drop a stale selection if the team changed and it's no longer valid.
        if (formData && !shorts.includes(formData)) {
          onChange(undefined as unknown as string);
        }
      })
      .catch(e => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team]);

  const helperText = (() => {
    if (!team) return 'Select a Team first';
    if (error) return `Failed to load Products: ${error}`;
    if (loading) return 'Loading Products…';
    if (products.length === 0) {
      return 'No Products owned by this Team yet — create one with New Product first';
    }
    return schema?.description as string | undefined;
  })();

  return (
    <TextField
      select
      id={idSchema?.$id}
      label={schema?.title ?? 'Product'}
      helperText={helperText}
      margin="normal"
      variant="outlined"
      fullWidth
      required={required}
      disabled={!team || loading}
      error={(rawErrors?.length ?? 0) > 0 && !formData}
      value={formData ?? ''}
      onChange={e => onChange((e.target.value as string) || (undefined as unknown as string))}
    >
      {products.map(p => (
        <MenuItem key={p} value={p}>
          {p}
        </MenuItem>
      ))}
    </TextField>
  );
};
