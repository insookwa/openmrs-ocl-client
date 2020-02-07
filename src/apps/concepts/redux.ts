import {
  AppState,
  completeAction,
  createActionThunk,
  indexedAction,
  loadingSelector,
  progressAction, progressSelector, resetAction,
  startAction,
} from '../../redux'
import api from './api'
import { APIConcept, Concept, ConceptsState, Mapping } from './types'
import { errorListSelector, errorSelector } from '../../redux/redux'
import { createReducer } from '@reduxjs/toolkit'
import {removeReferencesFromDictionaryAction as removeReferencesFromDictionary, addConceptsToDictionaryAction as addConceptsToDictionary} from '../dictionaries'

const UPSERT_CONCEPT_ACTION = 'concepts/upsertConcept'
const RETRIEVE_CONCEPT_ACTION = 'concepts/retrieveConcept'
const UPSERT_MAPPING_ACTION = 'concepts/upsertMapping'
const UPSERT_CONCEPT_AND_MAPPINGS = 'concepts/createConceptAndMappings'
const RETRIEVE_CONCEPTS_ACTION = 'concepts/retrieveConcepts'

const ANSWERS_BATCH_INDEX = 0
const SETS_BATCH_INDEX = 1
const MAPPINGS_BATCH_INDEX = 2

const retrieveConceptAction = createActionThunk(RETRIEVE_CONCEPT_ACTION, api.concept.retrieve)
const upsertConceptAndMappingsAction = (data: Concept, sourceUrl: string, linkedDictionary?: string) => {
  return async (dispatch: Function, getState: Function) => {

    dispatch(startAction(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS)))

    const { answers, sets, mappings, ...concept } = data

    const updating: boolean = !!concept.url

    let response: APIConcept | boolean

    dispatch(progressAction(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS), `${updating ? 'Updating' : 'Creating'} concept...`))
    const [action, url] = concept.url ?
      [createActionThunk(UPSERT_CONCEPT_ACTION, api.concept.update), concept.url] :
      [createActionThunk(UPSERT_CONCEPT_ACTION, api.concepts.create), sourceUrl]
    response = await dispatch(action<APIConcept>(url, concept))

    if (typeof response === 'boolean') {
      // I think that at this point, it is generally sane not to try dealing with the mappings if the concept can't be updated. todo could improve.
      dispatch(progressAction(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS), `Couldn't ${updating ? 'update' : 'create'} concept`))
      dispatch(completeAction(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS)))
      return false
    }

    const conceptResponse: APIConcept = response

    await dispatch(resetAction(UPSERT_MAPPING_ACTION))

    const upsertMappings = async (rawMappings: Mapping[], batchIndex: number, message: string) => {
      if (rawMappings.length) dispatch(progressAction(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS), `${updating ? 'Updating' : 'Creating'} ${message}...`))

      const mappings = rawMappings.map(mapping => {
        const { to_source_url, to_concept_code, to_concept_url, external_id, map_type, to_concept_name, retired, url } = mapping
        const common = { external_id, map_type, to_concept_name, retired, url }
        return to_concept_url ?
          {
            ...common,
            from_concept_url: conceptResponse.url,
            to_concept_url,
          } :
          {
            ...common,
            from_concept_url: conceptResponse.url,
            to_source_url,
            to_concept_code,
          }
      })

      const actions: [Mapping, CallableFunction, string][] = mappings.map((mapping, index) => [
        mapping,
        createActionThunk(indexedAction(UPSERT_MAPPING_ACTION, Number(`${batchIndex}${index}`)), mapping.url ? api.mapping.update : api.mappings.create),
        mapping.url ? mapping.url : sourceUrl,
      ])
      await Promise.all(actions.map(([mapping, action, url]) => dispatch(action(url, mapping))))
    }

    // I know you're thinking, oh, we could have done these in parallel
    // I see your in-parallel and raise you my race-condition
    // If a user duplicates a mapping say in answers and sets, we want to be able to sequentially point this out
    // todo some more robust error handling
    await upsertMappings(answers, ANSWERS_BATCH_INDEX, 'answers')
    await upsertMappings(sets, SETS_BATCH_INDEX, 'sets')
    await upsertMappings(mappings, MAPPINGS_BATCH_INDEX, 'mappings')

    if (linkedDictionary) {
      dispatch(progressAction(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS), 'Updating concept in dictionary...'))

      const state: AppState = getState();
      const toConceptUrls: string[] = [
        ...state.concepts.mappings.map(mapping => mapping.to_concept_url),
      ].filter(reference => reference) as string[];

      try {
        // ideally, this block should be atomic
        if (updating) {
          let referencesToRemove = [
            // we don't remove the toConceptUrls because we can't be sure no other mapping depends on them
            // that would break the OCL module importer
            // ...state.concepts.mappings.map(mapping => mapping.url), todo ensure the cascade is working and delete this if so
            concept.version_url,
          ].filter(reference => reference) as string[];
          await dispatch(removeReferencesFromDictionary(linkedDictionary, referencesToRemove));
        }

        await Promise.all([
          dispatch(addConceptsToDictionary(linkedDictionary, [conceptResponse.url])),
          dispatch(addConceptsToDictionary(linkedDictionary, toConceptUrls, 'none')),
        ]);
      } catch (e) {
        // whatever happens, make sure we never loose access to the reference from the dictionary
        await dispatch(addConceptsToDictionary(linkedDictionary, [conceptResponse.url || concept.url as string]));
      }
    }

    dispatch(progressAction(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS), ''))
    dispatch(completeAction(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS)))
  }
}
const retrieveConceptsAction = createActionThunk(RETRIEVE_CONCEPTS_ACTION, api.concepts.retrieve)

const initialState: ConceptsState = {
  mappings: [],
}

const reducer = createReducer<ConceptsState>(initialState, {
  [startAction(indexedAction(UPSERT_CONCEPT_ACTION)).type]: state => ({ ...state, concept: undefined }),
  [startAction(indexedAction(RETRIEVE_CONCEPT_ACTION)).type]: state => ({ ...state, concept: undefined }),
  [UPSERT_CONCEPT_ACTION]: (state, action) => ({ ...state, concept: action.payload }),
  [RETRIEVE_CONCEPT_ACTION]: (state, {payload}) => ({ ...state, concept: payload, mappings: payload.mappings || [] }),
  [RETRIEVE_CONCEPTS_ACTION]: (state, action) => ({ ...state, concepts: { items: (action.payload as APIConcept[]), responseMeta: action.responseMeta } }),
  [UPSERT_MAPPING_ACTION]: (state, { actionIndex, payload, meta }) => {
    const mappingIndex = state.mappings.findIndex(mapping => mapping.external_id === payload.external_id);
    if (mappingIndex !== -1) state.mappings[mappingIndex] = payload;
    else state.mappings.push(payload);
  },
})

const upsertConceptAndMappingsLoadingSelector = loadingSelector(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS))
const upsertConceptAndMappingsProgressSelector = progressSelector(indexedAction(UPSERT_CONCEPT_AND_MAPPINGS))
const upsertConceptErrorsSelector = errorSelector(indexedAction(UPSERT_CONCEPT_ACTION))
const viewConceptLoadingSelector = loadingSelector(indexedAction(RETRIEVE_CONCEPT_ACTION))
const viewConceptErrorsSelector = errorSelector(indexedAction(RETRIEVE_CONCEPT_ACTION))
const viewConceptsLoadingSelector = loadingSelector(indexedAction(RETRIEVE_CONCEPTS_ACTION))
const viewConceptsErrorsSelector = errorSelector(indexedAction(RETRIEVE_CONCEPTS_ACTION))
const upsertAllMappingsErrorSelector = errorListSelector(UPSERT_MAPPING_ACTION)

export {
  reducer as default,
  upsertConceptAndMappingsAction,
  retrieveConceptAction,
  upsertConceptAndMappingsLoadingSelector,
  upsertConceptAndMappingsProgressSelector,
  upsertConceptErrorsSelector,
  viewConceptLoadingSelector,
  viewConceptErrorsSelector,
  retrieveConceptsAction,
  viewConceptsLoadingSelector,
  viewConceptsErrorsSelector,
  upsertAllMappingsErrorSelector,
  ANSWERS_BATCH_INDEX,
  SETS_BATCH_INDEX,
  MAPPINGS_BATCH_INDEX,
}
