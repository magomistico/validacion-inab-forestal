import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import _ from "lodash";
import { stateAtom } from '../utils/constants';
import { previewSelectedSampleIdAtom, previewUserSamplesAtom } from '../state/projectWizard';
import { mercator } from '../utils/mercator';
import { SidebarCard } from "./Sidebar";
import SvgIcon from "./svg/SvgIcon";
import {
  lengthObject,
  filterObject,
  mapObjectArray,
  intersection,
} from '../utils/sequence';

import '../../css/sidebar.css';
import '../../css/survey.css';


export function SurveyQuestions ({
  preview = false,
  surveyQuestions = null,
  showHeader
}) {
  const {
    currentProject,
    currentPlot,
    mapConfig,
    selectedQuestionId,
    selectedSampleId: globalSelectedId,
    userSamples: globalUserSamples,
    selectedSampleIds
  } = useAtomValue(stateAtom);
  const setAppState = useSetAtom(stateAtom);

  // PREVIEW STATE HOOKS
  const [previewUserSamples, setPreviewUserSamples] = useAtom(previewUserSamplesAtom);
  const previewSelectedId = useAtomValue(previewSelectedSampleIdAtom);

  // SWITCH DATA SOURCES BASED ON PREVIEW FLAG
  const surveyData = useMemo(() => {
    return preview ? surveyQuestions : currentProject?.surveyQuestions;
  }, [preview, surveyQuestions, currentProject?.surveyQuestions]);
  const userSamples = preview
        ? previewUserSamples
        : globalUserSamples;
  const selectedSampleId = preview
        ? previewSelectedId
        : globalSelectedId;
  const activeSampleId =
    selectedSampleId != null && selectedSampleId >= 0
      ? selectedSampleId
      : selectedSampleIds.length === 1
      ? selectedSampleIds[0]
      : -1;
  const [openTopId, setOpenTopId] = useState(1);
  // Children are expanded by default once visible (parent answered);
  // this only tracks the ones the user collapsed.
  const [collapsedChildIds, setCollapsedChildIds] = useState({});
  const [scrollToChildrenOf, setScrollToChildrenOf] = useState(null);
  const childrenRefs = useRef({});

  const entries = (obj = {}) => Object.entries(obj || {});
  const visibleAnswers = (q) => entries(q.answers).filter(([, a]) => !a?.hide);


  useEffect(() => {
    setCollapsedChildIds({});
  }, [currentPlot?.id]);

  useEffect(() => {
    if (scrollToChildrenOf == null) return;
    childrenRefs.current[scrollToChildrenOf]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    setScrollToChildrenOf(null);
  }, [scrollToChildrenOf]);

  const getEffectiveVisibleIds = (questionId) => {
    const q = surveyData?.[questionId];
    const visibleIds = (q?.visible || []).map((v) => v.id);
    if (visibleIds.length > 0) return visibleIds;

    if (q && [-1, "-1"].includes(q.parentQuestionId)) {
      const allFeatureIds = (mercator.getAllFeatures(mapConfig, "currentSamples") || []).map((f) =>
        f.get("sampleId")
      );
      if (allFeatureIds.length > 0) return allFeatureIds;
      const plotSampleIds = (currentPlot?.samples || []).map((s) => s.id);
      if (plotSampleIds.length > 0) return plotSampleIds;
      return Object.keys(userSamples || {}).map(Number).filter((id) => !Number.isNaN(id));
    }

    return [];
  };

  const getSelectedSampleIds = (questionId) => {
    if (preview) return [selectedSampleId != null && selectedSampleId >= 0 ? selectedSampleId : 1];

    const q = surveyData?.[questionId];
    const effectiveVisibleIds = getEffectiveVisibleIds(questionId);
    if (effectiveVisibleIds.length === 0) return [];

    if (selectedSampleIds.length > 0) {
      const validSelected = selectedSampleIds.filter((id) => effectiveVisibleIds.includes(id));
      if (validSelected.length > 0) {
        return validSelected;
      }
    }

    if (effectiveVisibleIds.length === 1 || lengthObject(userSamples) === 1) {
      return effectiveVisibleIds;
    }

    const answeredIds = new Set((q?.answered || []).map((a) => a.sampleId));
    if (answeredIds.size === 0) {
      return effectiveVisibleIds;
    }

    const unansweredIds = effectiveVisibleIds.filter((id) => !answeredIds.has(id));
    if (unansweredIds.length > 0) {
      return unansweredIds;
    }

    // All visible samples are already answered and none were manually narrowed:
    // update all visible samples instead of blocking with a Selection Error.
    return effectiveVisibleIds;
  };

  const checkSelection = (sampleIds, questionId) => {
    if (preview) return true;
    const visibleIds = getEffectiveVisibleIds(questionId);
    const invalid = sampleIds.filter((id) => !visibleIds.includes(id));

    if (invalid.length) {
      setAppState((s) => ({
        ...s,
        modal: {
          alert: {
            alertType: "Selection Error",
            alertMessage: "Invalid Selection. Try selecting the question before answering."
          }
        }
      }));
      return false;
    }

    if (sampleIds.length === 0) {
      setAppState((s) => ({
        ...s,
        modal: { alert: {
          alertType: "Selection Error",
          alertMessage: "Please select at least one sample before choosing an answer."
        }}
      }));
      return false;
    }

    return true;
  };

  const setCurrentValue = (questionId, answerId, answerText, resolvedSampleIds = null) => {
    const sampleIds = resolvedSampleIds ?? getSelectedSampleIds(questionId);
    if (!preview && !checkSelection(sampleIds, questionId)) return;
    if (preview) {
      setPreviewUserSamples((prev) => {
        const newSamples = sampleIds.reduce((acc, sampleId) => {
          if (answerText == null) return acc;
          const childIds = getChildQuestionIds(questionId);
          const prevAnswers = prev?.[sampleId] || {};
          const subQuestionsCleared = filterObject(
            prevAnswers,
            ([key]) => !childIds.includes(Number(key))
          );
          const newQuestion = { answerId };
          if (answerText !== "") newQuestion.answer = answerText;

          acc[sampleId] = {
            ...subQuestionsCleared,
            [questionId]: newQuestion,
          };
          return acc;
        }, {});

        return { ...prev, ...newSamples };
      });

      syncOpenChildren(questionId, answerId, answerText);
      return;
    }

    setAppState((prev) => {
      const childQuestionIds = getChildQuestionIds(questionId);
      const newSamples = sampleIds.reduce((acc, sampleId) => {
        if (answerText == null) return acc;
        const prevSampleAnswers = prev.userSamples?.[sampleId] || {};
        const subQuestionsCleared = filterObject(
          prevSampleAnswers,
          ([key]) => !childQuestionIds.includes(Number(key))
        );
        const newQuestion = { answerId };
        if (answerText !== "") newQuestion.answer = answerText;
        acc[sampleId] = { ...subQuestionsCleared, [questionId]: newQuestion };
        return acc;
      }, {});
      if (!Object.keys(newSamples).length) return prev;
      const newUserImages = sampleIds.reduce((acc, sampleId) => {
        acc[sampleId] = {
          id: prev.currentImagery.id,
          attributes:
          prev.currentImagery?.sourceConfig?.type === "PlanetDaily"
            ? {
              ...prev.imageryAttributes,
              imageryDatePlanetDaily: mercator.getTopVisiblePlanetLayerDate(
                prev.mapConfig,
                prev.currentImagery.id
              ),
            }
          : prev.imageryAttributes,
        };
        return acc;
      }, {});
      return {
        ...prev,
        userSamples: { ...(prev.userSamples || {}), ...newSamples },
        userImages:  { ...(prev.userImages  || {}), ...newUserImages },
      };
    });

    syncOpenChildren(questionId, answerId, answerText);
  };

  const getOpenChildren = (questionId, answerId, answerText) => {
    const parent = surveyData?.[questionId];
    if (!parent) return [];

    return childrenOf(questionId, surveyData).filter((child) => {
      if (parent.componentType === 'input') {
        return String(answerText ?? '').length > 0;
      }
      const allowed = Array.isArray(child.parentAnswerIds) ? child.parentAnswerIds : [];
      return allowed.length === 0 || allowed.includes(Number(answerId));
    });
  };

  const getDescendantIds = (questionId) =>
        childrenOf(questionId, surveyData).reduce(
          (acc, child) => [...acc, child.id, ...getDescendantIds(child.id)],
          []
        );

  const syncOpenChildren = (questionId, answerId, answerText) => {
    if (answerText == null) return;

    const descendants = getDescendantIds(questionId);
    setCollapsedChildIds((prev) => _.omit(prev, descendants));

    if (getOpenChildren(questionId, answerId, answerText).length > 0) {
      setScrollToChildrenOf(questionId);
    }
  };

  // is this child eligible to show given the parent's current answer?
  const isChildVisible = (child) => {
    const parentId = child.parentQuestionId;
    if (parentId == null || parentId < 0) return false;

    const parent = surveyData?.[parentId];
    if (!parent) return false;

    const parentAns = getCurrentAnswer(parentId);
    if (!parentAns) return false;

    if (parent.componentType === 'input') {
      return String(parentAns.answer ?? '').length > 0;
    }

    const allowed = Array.isArray(child.parentAnswerIds) ? child.parentAnswerIds : [];
    return allowed.length === 0 || allowed.includes(Number(parentAns.answerId));
  };

  const childrenOf = (parentId, data) =>
        mapObjectArray(
          data || {},
          ([id, q]) => ({ id: Number(id), ...q })
        )
        .filter(q => q.parentQuestionId === parentId && !q.hideQuestion)
        .sort((a, b) => (a.cardOrder ?? 1e9) - (b.cardOrder ?? 1e9));

  const getAnswerForSample = (qId, sampleId) => {
    const us = userSamples?.[sampleId]?.[qId];
    if (us) return { answerId: Number(us.answerId), answer: us.answer };
    const a = (surveyData?.[qId]?.answered || [])
          .find(x => Number(x.sampleId) === Number(sampleId));
    return a ? { answerId: Number(a.answerId), answer: a.answerText } : null;
  };

  const isSampleAnswered = (qId, ansObj) => {
    if (!ansObj) return false;
    const q = surveyData?.[qId];
    if (!q) return false;
    if (q.componentType === 'input') {
      const val = (ansObj.answer ?? '').toString().trim();
      // number: must be non-empty and not NaN; text: non-empty string
      if (q.dataType === 'number') return val !== '' && !Number.isNaN(Number(val));
      return val.length > 0;
    }
    // buttons/radio/dropdown: require a concrete answerId
    return ansObj.answerId !== null && ansObj.answerId !== undefined;
  };

  const getQuestionStatusShallow = (questionId) => {
    const qLive = surveyData?.[questionId];
    const visibleArr =
      Array.isArray(qLive?.visible) && qLive.visible.length > 0
        ? qLive.visible
        : preview
        ? [{ id: selectedSampleId != null && selectedSampleId >= 0 ? selectedSampleId : 1 }]
        : (qLive && [-1, "-1"].includes(qLive.parentQuestionId)
          ? (mercator.getAllFeatures(mapConfig, "currentSamples") || []).map((f) => ({ id: f.get("sampleId") }))
          : []);
    if (visibleArr.length === 0) return 'none';
    const visibleIds = visibleArr.map(v => Number(v.id));

    let answeredCount = 0;
    for (const sid of visibleIds) {
      const ans = getAnswerForSample(questionId, sid);
      if (isSampleAnswered(questionId, ans)) answeredCount++;
    }
    if (answeredCount === 0) return 'none';
    if (answeredCount === visibleIds.length) return 'complete';
    return 'partial';
  };

  //Check if the answer has been fully answered for all samples to determine its status
  const getQuestionStatus = (questionId) => {
    const base = getQuestionStatusShallow(questionId);

    // if this question itself has no answers yet, it's 'none' regardless of children
    if (base === 'none') return 'none';

    const children = childrenOf(questionId, surveyData).filter(isChildVisible);
    if (children.length === 0) return base;
    const childStatuses = children.map(child => getQuestionStatus(child.id));
    // complete only if this question AND all visible descendants are complete
    if (base === 'complete' && childStatuses.every(s => s === 'complete')) {
      return 'complete';
    }
    return 'partial';
  };

  // Gets answers for a question depending on the userSample
  const getCurrentAnswer = (questionId) => {
    const toNum = (v) => (v == null ? v : Number(v));
    if (activeSampleId != null && activeSampleId >= 0) {
      const us = userSamples?.[activeSampleId]?.[questionId];
      if (us) return { answerId: toNum(us.answerId), answer: us.answer };
      const fromSurvey = (surveyData?.[questionId]?.answered || [])
            .find(a => Number(a.sampleId) === Number(activeSampleId));
      if (fromSurvey) return { answerId: toNum(fromSurvey.answerId), answer: fromSurvey.answerText };
      return null;
    }
    const anyAnswers = (surveyData?.[questionId]?.answered || [])[0];
    if (anyAnswers) {
      return {
        answerId: toNum(anyAnswers.answerId), answer: anyAnswers.answerText
      };
    }
    const first = Object.values(userSamples || {}).find(sample => sample?.[questionId]);
    return first ? { answerId: toNum(first[questionId].answerId), answer: first[questionId].answer } : null;
  };

  
  // Get child question ids
  const getChildQuestionIds = (currentQuestionId) => {
    const surveyQuestionsData = surveyData || {};

    const directChildren = mapObjectArray(
      filterObject(surveyQuestionsData, ([_id, val]) => val.parentQuestionId === currentQuestionId),
      ([key]) => Number(key)
    );

    if (directChildren.length === 0) {
      return [currentQuestionId];
    }
    return directChildren.reduce(
      (acc, childId) => [...acc, ...getChildQuestionIds(childId)],
      [currentQuestionId]
    );
  };

  const keyDifference = (o1, features) => {
    const objKeys = o1.map(i => i.sampleId);
    const sampleIds = features.map(f => f.get("sampleId"));
    const unansweredKeys = sampleIds.filter(k => !objKeys.includes(k));
    return features.filter(f => unansweredKeys.includes(f.get("sampleId")));
  };

  // RENDERING FUNCTIONS
  const renderQuestionNode = (question, depth = 0, parentId = null) => {
    const isOpen =
          depth === 0
          ? openTopId === question.id
          : !collapsedChildIds[question.id];

    const children = childrenOf(question.id, surveyData).filter(isChildVisible);
    const status = getQuestionStatus(question.id);

    const handleToggle = () => {
      
      if (depth === 0) {
        setOpenTopId(prev => (prev === question.id ? null : question.id));
      } else {
        setCollapsedChildIds(prev => ({ ...prev, [question.id]: !prev[question.id] }));
      }
      setAppState(s => ({ ...s, selectedQuestionId: question.id }));
    };
    
    return (
      <div key={question.id} className={`sq-item ${isOpen ? 'open' : ''} ${depth ? 'sq-item--child' : ''} depth-${depth}`}>
        <button className="sq-item-head" onClick={handleToggle}>
          <span className={`sq-radio sq-radio--${status}`} aria-hidden="true">
            {status === 'complete' && (
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path d="M6.5 11.2L3.3 8l1.1-1.1 2.1 2.1 5.1-5.1L12.7 5 6.5 11.2z" fill="currentColor"/>
              </svg>
            )}
            {status === 'partial' && (
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                <rect x="4" y="9" width="12" height="2" fill="currentColor" rx="1" />
              </svg>
            )}
          </span>
          <span className="sq-text">{question.question}{question.required && (
            <span style={{ color: 'red' }}>*</span>)}</span>
          <SvgIcon icon={isOpen ? "upCaret" : "downCaret"} size="1rem" />
        </button>

        {isOpen && (
          <>
            <AnswerUI q={question} />
            {children.length > 0 && (
              <div
                className="sq-children"
                ref={(el) => { childrenRefs.current[question.id] = el; }}
              >
                {children.map(child => renderQuestionNode(child, depth + 1, question.id))}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const renderers = {
    button: (q) => {      
      const current = getCurrentAnswer(q.id);
      const opts = visibleAnswers(q);
      return (
        <div className="sq-answers">
          {opts.map(([id, a]) => {
            const isActive = current && Number(current.answerId) === Number(id);
            return (
              <button
                key={id}
                style={{
                  borderColor: isActive ? a.color : '#3d7f7a',
                  borderWidth: '2px',
                  boxShadow: isActive ? `0 0 0 2px ${a.color}` : 'none',
                  fontWeight: isActive ? 'bold' : 'normal'
                }}
                className={`sq-pill ${isActive ? 'active' : ''}`}
                onClick={() => validateAndSetCurrentValue(q.id, Number(id), a.answer)}
              >
                <span className="dot" style={{ background: a.color }} />
                {String(a.answer)}
              </button>
            );
          })}
        </div>
      );
    },

    radiobutton: (q) => {
      const current = getCurrentAnswer(q.id);
      return (
        <div className="sq-radio-group">
          {visibleAnswers(q).map(([id, a]) => (
            <label key={id} className="sq-radio-option">
              <input
                type="radio"
                name={`q-${q.id}`}
                checked={current ? Number(current.answerId) === Number(id) : false}
                onChange={() => validateAndSetCurrentValue(q.id, Number(id), a.answer)}
              />
              <span>{String(a.answer)}</span>
            </label>
          ))}
        </div>
      );
    },

    dropdown: (q) => {
      const current = getCurrentAnswer(q.id);
      const value = current ? String(current.answerId) : '';
      return (
        <div className="sq-dropdown-wrap">
          <select
            className="sq-select"
            value={value}
            onChange={(e) => {
              const selectedId = e.target.value;
              if (selectedId === '') return;
              const ans = q.answers[selectedId];
              if (ans) validateAndSetCurrentValue(q.id, Number(selectedId), ans.answer);
            }}
          >
            <option value="" style={{ backgroundColor: "#0b110d", color: "#a1a1aa" }}>
              Select
            </option>
            {visibleAnswers(q).map(([id, a]) => (
              <option
                key={id}
                value={id}
                style={{ backgroundColor: "#0b110d", color: a.color || "#f4f4f5" }}
              >
                ● {String(a.answer)}
              </option>
            ))}
          </select>
        </div>
      );
    },

    input: (q) => {
      const current = getCurrentAnswer(q.id);
      const val = current?.answer ?? '';
      const inputAnswerId = Number(Object.keys(q.answers || {})[0] ?? 0);
      return (
        <div className="sq-input-wrap">
          <input
            key={`${currentPlot?.id ?? 'preview'}-${activeSampleId}-${q.id}`}
            className="sq-input"
            type={q.dataType}
            placeholder={val !== '' ? String(val) : (q.questionLabel || q.question)}
            defaultValue={val}
            onBlur={(e) => {
              const nextVal = e.target.value;
              if (nextVal === String(val)) return;
              const ok = validateAndSetCurrentValue(q.id, inputAnswerId, nextVal);
              if (!ok) e.target.value = String(val);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const nextVal = e.currentTarget.value;
                const ok = validateAndSetCurrentValue(q.id, inputAnswerId, nextVal);
                if (!ok) e.currentTarget.value = String(val);
              }
            }}
          />
        </div>
      );
    },
  };

  const AnswerUI = ({ q }) => {
    const render = renderers[q.componentType];
    return render ? render(q) : null;
  };

  // MEMOIZATION
  const parents = useMemo(() => {
    return Object.entries(surveyData)
      .map(([id, q]) => ({ id: Number(id), ...q }))
      .filter(q => (q.parentQuestionId === -1 || q.parentQuestionId === "-1") && !q.hideQuestion)
      .sort((a, b) => (a.cardOrder ?? 1e9) - (b.cardOrder ?? 1e9));
  }, [surveyData]);

  const { validatedCount, totalTop } = useMemo(() => {
    const total = parents.length;
    let validated = 0;
    for (const p of parents) {
      if (getQuestionStatus(p.id) === 'complete') validated++;
    }
    return { validatedCount: validated, totalTop: total };
  }, [parents, surveyData, userSamples]);


  // SURVEY RULES
  const getSurveyQuestionText = (questionId) => {
    const visibleSurveyQuestions = filterObject(surveyData || {}, ([_id, val]) => val.hideQuestion != true);
    return _.get(visibleSurveyQuestions, [questionId, "question"], "");
  };

  const getSurveyAnswerText = (questionId, answerId) => {
    return _.get(surveyData, [questionId, "answers", answerId, "answer"], "");
  };

  const checkRuleTextMatch = (surveyRule, questionIdToSet, _answerId, answerText) => {
    if (surveyRule.questionId === questionIdToSet && !RegExp(surveyRule.regex).test(answerText)) {
      return `Text match validation failed.\r\n\nPlease enter an answer that matches the expression: ${surveyRule.regex}`;
    } else {
      return null;
    }
  };

  const checkRuleNumericRange = (surveyRule, questionIdToSet, _answerId, answerText) => {
    const numVal = Number(answerText);
    if (
      surveyRule.questionId === questionIdToSet &&
        answerText !== "" &&
        (Number.isNaN(numVal) || numVal < Number(surveyRule.min) || numVal > Number(surveyRule.max))
    ) {
      return `Numeric range validation failed.\r\n\n Please select a value between ${surveyRule.min} and ${surveyRule.max}`;
    } else {
      return null;
    }
  };

  const sumAnsweredQuestionsPerSample = (answeredQuestions, sampleId) =>
        Object.entries(answeredQuestions).reduce((acc, [_qId, aq]) => {
          const answer = (aq.answered || []).find((ans) => Number(ans.sampleId) === Number(sampleId));
          const answeredVal = answer
            ? Number(answer.answerText || aq.answers?.[answer.answerId]?.answer || 0)
            : 0;
          return acc + answeredVal;
        }, 0);

  const getAnsweredQuestions = (ruleQuestions, questionIdToSet) =>
        filterObject(surveyData || {}, ([sqId, sq]) => {
          const numSqId = Number(sqId);
          return (
            ruleQuestions.includes(numSqId) && (sq.answered || []).length > 0 && numSqId !== questionIdToSet
          );
        });

  const getAnsweredSampleIds = (answeredQuestions) =>
        mapObjectArray(answeredQuestions, ([_sqId, aq]) => (aq.answered || []).map((a) => a.sampleId));

  const checkRuleSumOfAnswers = (surveyRule, questionIdToSet, answerId, answerText, sampleIds = []) => {
    const answerVal = !isNaN(Number(answerText)) ?
          Number(answerText) : Number(getSurveyAnswerText(questionIdToSet, answerId));
    if (surveyRule.questionIds.includes(questionIdToSet)) {
      const answeredQuestions = getAnsweredQuestions(surveyRule.questionIds, questionIdToSet);
      if (surveyRule.questionIds.length === lengthObject(answeredQuestions) + 1) {
        const answeredSampleIds = getAnsweredSampleIds(answeredQuestions);
        const commonSampleIds = answeredSampleIds.reduce(intersection, sampleIds);
        if (commonSampleIds.length > 0) {
          const invalidSum = commonSampleIds
                .map((sampleId) => sumAnsweredQuestionsPerSample(answeredQuestions, sampleId))
                .find((s) => s + answerVal !== surveyRule.validSum);
          if (invalidSum || invalidSum === 0) {
            const { question = "" } = surveyData?.[questionIdToSet] || {};
            return `Sum of answers validation failed.\r\n\nSum for questions [${surveyRule.questionIds
              .map((q) => getSurveyQuestionText(q))
              .toString()}] must be ${surveyRule.validSum.toString()}.\r\n\nAn acceptable answer for "${question}" is ${(
                surveyRule.validSum - invalidSum
              ).toString()}.`;
          } else {
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else {
      return null;
    }
  };

  const checkRuleMatchingSums = (surveyRule, questionIdToSet, answerId, answerText, sampleIds = []) => {
    const answerVal =
          Number(answerText) || Number(getSurveyAnswerText(questionIdToSet, answerId));
    if (surveyRule.questionIds1.concat(surveyRule.questionIds2).includes(questionIdToSet)) {
      const answeredQuestions1 = getAnsweredQuestions(
        surveyRule.questionIds1,
        questionIdToSet
      );
      const answeredQuestions2 = getAnsweredQuestions(
        surveyRule.questionIds2,
        questionIdToSet
      );
      const ansLen1 = lengthObject(answeredQuestions1);
      const ansLen2 = lengthObject(answeredQuestions2);
      const ruleLen1 = lengthObject(surveyRule.questionIds1);
      const ruleLen2 = lengthObject(surveyRule.questionIds2);
      const ready = (al1, rl1, al2, rl2) => al1 > 1 && rl1 === al1 && rl2 === al2 + 1;
      if (
        ready(ansLen1, ruleLen1, ansLen2, ruleLen2) ||
          ready(ansLen2, ruleLen2, ansLen1, ruleLen1)
      ) {
        const answeredSampleIds1 = getAnsweredSampleIds(answeredQuestions1);
        const commonSampleIds1 = answeredSampleIds1.reduce(intersection, sampleIds);
        const answeredSampleIds2 = getAnsweredSampleIds(answeredQuestions2);
        const commonSampleIds2 = answeredSampleIds2.reduce(intersection, sampleIds);
        const commonSampleIds = intersection(commonSampleIds1, commonSampleIds2);
        if (commonSampleIds.length > 0) {
          const q1Value = surveyRule.questionIds1.includes(questionIdToSet) ? answerVal : 0;
          const q2Value = surveyRule.questionIds2.includes(questionIdToSet) ? answerVal : 0;
          const invalidSum = commonSampleIds
                .map((sampleId) => {
                  const sum1 = sumAnsweredQuestionsPerSample(answeredQuestions1, sampleId);
                  const sum2 = sumAnsweredQuestionsPerSample(answeredQuestions2, sampleId);
                  return [sum1, sum2];
                })
                .find((sums) => sums[0] + q1Value !== sums[1] + q2Value);
          if (invalidSum) {
            const { question = "" } = surveyData?.[questionIdToSet] || {};
            return (
              "Matching sums validation failed.\r\n\n" +
                `Totals of the question sets [${surveyRule.questionIds1
                  .map((q) => getSurveyQuestionText(q))
                  .toString()}] and [${surveyRule.questionIds2
                    .map((q) => getSurveyQuestionText(q))
                    .toString()}] do not match.\r\n\n` +
                `An acceptable answer for "${question}" is ${Math.abs(
                  invalidSum[0] - invalidSum[1]
                )}.`
            );
          } else {
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else {
      return null;
    }
  };

  const checkRuleIncompatibleAnswers = (surveyRule, questionIdToSet, answerId, _answerText, sampleIds = []) => {
    if (surveyRule.questionId1 === questionIdToSet && Number(surveyRule.answerId1) === Number(answerId)) {
      const ques2 = surveyData?.[surveyRule.questionId2];
      const ques2Answered = ques2?.answered || [];
      if (ques2Answered.some((ans) => Number(ans.answerId) === Number(surveyRule.answerId2))) {
        const ques1Ids = sampleIds;
        const ques2Ids = ques2Answered
              .filter((ans) => Number(ans.answerId) === Number(surveyRule.answerId2))
              .map((a) => a.sampleId);
        const commonSampleIds = intersection(ques1Ids, ques2Ids);
        if (commonSampleIds.length > 0) {
          return `Incompatible answers validation failed.\r\n\nAnswer "${getSurveyAnswerText(
            surveyRule.questionId1,
            surveyRule.answerId1
          )}" from question "${getSurveyQuestionText(
            surveyRule.questionId1
          )}" is incompatible with\r\n answer "${getSurveyAnswerText(
            surveyRule.questionId2,
            surveyRule.answerId2
          )}" from question "${getSurveyQuestionText(surveyRule.questionId2)}".\r\n\n`;
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else if (surveyRule.questionId2 === questionIdToSet && Number(surveyRule.answerId2) === Number(answerId)) {
      const ques1 = surveyData?.[surveyRule.questionId1];
      const ques1Answered = ques1?.answered || [];
      if (ques1Answered.some((ans) => Number(ans.answerId) === Number(surveyRule.answerId1))) {
        const ques2Ids = sampleIds;
        const ques1Ids = ques1Answered
              .filter((ans) => Number(ans.answerId) === Number(surveyRule.answerId1))
              .map((a) => a.sampleId);
        const commonSampleIds = intersection(ques1Ids, ques2Ids);
        if (commonSampleIds.length > 0) {
          return `Incompatible answers validation failed.\r\n\nAnswer "${getSurveyAnswerText(
            surveyRule.questionId2,
            surveyRule.answerId2
          )}" from question "${getSurveyQuestionText(
            surveyRule.questionId2
          )}" is incompatible with\r\nanswer "${getSurveyAnswerText(
            surveyRule.questionId1,
            surveyRule.answerId1
          )}" from question "${getSurveyQuestionText(surveyRule.questionId1)}".\r\n\n`;
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else {
      return null;
    }
  };

  const formatErrorText = (answerList) =>
        answerList.map((ans) => `answer "${getSurveyAnswerText(ans[0], ans[1])}" for question "${getSurveyQuestionText(ans[0])}"`);

  const checkRuleMultipleIncompatibleAnswers = (surveyRule, questionIdToSet, answerId, _answerText) => {
    const surveyQuestionsData = surveyData || {};
    const { answers, incompatQuestionId, incompatAnswerId } = surveyRule;
    const ruleAnswerList = Object.entries(answers || {});

    const answeredQuestionsList = ruleAnswerList.filter((answer) => {
      const question = surveyQuestionsData[answer[0]];
      return (question?.answered || []).some((a) => a.answerId == answer[1]);
    });
    const incompatQuestion = surveyQuestionsData[incompatQuestionId];
    const incompatAnswer = ((incompatQuestion?.answered || []).some((a) => a.answerId == incompatAnswerId) ||
                            (incompatQuestionId == questionIdToSet && incompatAnswerId == answerId));

    if (ruleAnswerList.length === answeredQuestionsList.length && incompatAnswer) {
      const answerText = surveyQuestionsData[questionIdToSet]?.answers?.[answerId]?.answer ?? "";
      const questionText = getSurveyQuestionText(questionIdToSet);
      const answerTextList = formatErrorText(ruleAnswerList);
      return `Answer "${answerText}" for question "${questionText}" is incompatible in case ${answerTextList} are selected.`;
    } else {
      return null;
    }
  };

  const rulesViolated = (questionIdToSet, answerId, answerText, sampleIds) => {
    const ruleFunctions = {
      "text-match": checkRuleTextMatch,
      "numeric-range": checkRuleNumericRange,
      "sum-of-answers": checkRuleSumOfAnswers,
      "matching-sums": checkRuleMatchingSums,
      "incompatible-answers": checkRuleIncompatibleAnswers,
      "multiple-incompatible-answers": checkRuleMultipleIncompatibleAnswers,
    };
    const rules = currentProject?.surveyRules || surveyData?.surveyRules;
    return (
      Array.isArray(rules) &&
        rules
        .map((surveyRule) => {
          const fn = ruleFunctions[surveyRule.ruleType];
          return fn ? fn(surveyRule, questionIdToSet, answerId, answerText, sampleIds) : null;
        })
        .find((msg) => msg)
    );
  };

  const validateAndSetCurrentValue = (questionIdToSet, answerId, answerText = null, previousAnswer = null) => {
    const sampleIds = getSelectedSampleIds(questionIdToSet);
    if (!preview && !checkSelection(sampleIds, questionIdToSet)) return false;

    const ruleError = preview ? null : rulesViolated(questionIdToSet, answerId, answerText, sampleIds);
    if (ruleError) {
      if (previousAnswer != null && typeof previousAnswer !== "object") {
        setCurrentValue(questionIdToSet, answerId, previousAnswer, sampleIds);
      }
      setAppState((s) => ({
        ...s,
        modal: {alert: {alertType: "Collection Error", alertMessage: ruleError}}
      }));
      return false;
    } else {
      setCurrentValue(questionIdToSet, answerId, answerText, sampleIds);
      return true;
    }
  };

  function InvertSelectionButton () {
    const allIds = (mercator.getAllFeatures(mapConfig, "currentSamples") || []).map(f => f.get("sampleId"));
    if (allIds.length <= 1 || selectedSampleIds.length === 0) {
      return null;
    }

    function clearSelectionHandler () {
      setAppState((s) => ({
        ...s,
        selectedSampleIds: [],
        selectedSampleId: -1,
      }));
      mercator.selectFeatures(mapConfig, []);
    }

    return (
      <button
        onClick={clearSelectionHandler}
        className="btn outline"
        title="Limpiar la selección manual de muestras"
      >
        {`Limpiar selección (${selectedSampleIds.length})`}
      </button>
    );
  }
  
  return (
    <SidebarCard
      showHeader={showHeader}      
      title={
        <>
          SURVEY{" "}
          <span className="sq-subtitle">
            {`${validatedCount}/${totalTop} questions answered`}
          </span>          
        </>
      }
      headerBtn={ !preview && <InvertSelectionButton/> }
      infoText="View and answer survey questions for this plot"
    >
      {currentPlot?.flagged ? (
        <>
          <h2 style={{ color: "#f87171" }}>
            This plot has been flagged, unflag it to collect data.
          </h2>
          <div className="sq-textarea-wrap">
            <label className="sq-textarea-label">Flagged Reason (optional):</label>
            <textarea
              className="sq-textarea"
              value={currentPlot?.flaggedReason || ""}
              onChange={(e) =>
                setAppState((s) => ({
                  ...s,
                  currentPlot: {
                    ...s.currentPlot,
                    flaggedReason: e.target.value,
                  },
                }))
              }
            />
          </div>
        </>
      ) : (
        <div className="sq-list">
          {parents.map((q) => renderQuestionNode(q, 0))}
          <ConfidenceItem
            isOpen={openTopId === "confidence"}
            onToggle={() =>
              setOpenTopId((prev) => (prev === "confidence" ? null : "confidence"))
            }
          />
        </div>
      )}
    </SidebarCard>
  );
};


const ConfidenceItem = ({ isOpen, onToggle }) => {
  const { currentProject, currentPlot } = useAtomValue(stateAtom);
  const setAppState = useSetAtom(stateAtom);
  const [confidenceStatus, setConfidenceStatus] = useState('none');

  if (!currentProject?.projectOptions?.collectConfidence) return null;

  const calculateConfidenceStatus = () => {
    const { confidence, confidenceComment } = currentPlot;
    const hasConfidence = Number.isInteger(confidence);
    const hasComment = String(confidenceComment ?? '').trim() !== '';
    if(hasConfidence && hasComment) {
      setConfidenceStatus('complete');
    } else if(!hasConfidence && !hasComment) {
      setConfidenceStatus('none');
    } else {
      setConfidenceStatus('partial');
    }
  }

  useEffect(() => {
    calculateConfidenceStatus();
  }, [currentPlot?.confidence, currentPlot?.confidenceComment]);
  
  return (
    <div className={`sq-item ${isOpen ? 'open' : ''}`}>
      <button className="sq-item-head" onClick={onToggle}>
        <span className={`sq-radio sq-radio--${confidenceStatus}`} aria-hidden="true" >
          {confidenceStatus === 'complete' && (
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
              <path d="M6.5 11.2L3.3 8l1.1-1.1 2.1 2.1 5.1-5.1L12.7 5 6.5 11.2z" fill="currentColor"/>
            </svg>
          )}
          {confidenceStatus === 'partial' && (
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <rect x="4" y="9" width="12" height="2" fill="currentColor" rx="1" />
            </svg>
          )}
        </span>
        <span className="sq-text">Plot Confidence</span>
        <SvgIcon icon={isOpen ? "upCaret" : "downCaret"} size="1rem" />
      </button>

      {isOpen && (
        <div className="sq-confidence">
          <label className="sq-range-label">
            Plot Confidence: {currentPlot?.confidence || 0}
          </label>

          <div className="sq-range-wrap">
            <input
              className="sq-range"
              type="range"
              min="0"
              max="100"
              step="1"
              value={currentPlot?.confidence || 0}
              onChange={(e) =>
                setAppState((s) => ({
                  ...s,
                  currentPlot: {
                    ...s.currentPlot,
                    confidence: parseInt(e.target.value, 10),
                  },
                }))
              }
            />
          </div>

          <div className="sq-textarea-wrap">
            <label className="sq-textarea-label">
              Comment on the confidence<span style={{ color: 'red' }}>*</span>
            </label>
            <textarea
              className="sq-textarea"
              value={currentPlot?.confidenceComment || ''}
              onChange={(e) =>
                setAppState((s) => ({
                  ...s,
                  currentPlot: {
                    ...s.currentPlot,
                    confidenceComment: e.target.value,
                  },
                }))
              }
            />
          </div>
        </div>
      )}
    </div>
  );
};

export const DrawingTool = () => {
  const { currentProject, currentPlot, mapConfig, answerMode } = useAtomValue(stateAtom);
  const setAppState = useSetAtom(stateAtom);
  const isDrawing = answerMode === "draw";

  const sg = currentProject?.sampleGeometries || {
    points: true,
    lines: true,
    polygons: true,
  };
  const initialDrawTool = sg.polygons ? "Polygon" : sg.lines ? "LineString" : "Point";
  const [drawTool, setDrawToolState] = useState(initialDrawTool);

  const setAnswerMode = (newMode, tool) => {
    setAppState((s) => ({ ...s, answerMode: newMode }));
    if (newMode === "draw") {
      featuresToDrawLayer(tool || drawTool);
    } else {
      featuresToSampleLayer();
    }
  };

  const featuresToDrawLayer = (tool) => {
    const type = currentProject.type;
    const samples = currentPlot?.samples || [];
    const visibleSamples =
          type === "simplified" ? samples.filter((s) => s.visibleId !== 1) : samples;

    mercator.disableDrawing(mapConfig);
    mercator.removeLayerById(mapConfig, "currentSamples");
    mercator.removeLayerById(mapConfig, "drawLayer");

    mercator.addVectorLayer(
      mapConfig,
      "drawLayer",
      mercator.samplesToVectorSource(visibleSamples),
      mercator.ceoMapStyles("draw", "orange"),
      9999
    );

    mercator.enableDrawing(mapConfig, "drawLayer", tool);
  };

  const featuresToSampleLayer = () => {
    mercator.disableDrawing(mapConfig);
    const allFeatures = mercator.getAllFeatures(mapConfig, "drawLayer") || [];
    const existingIds = allFeatures
          .map((f) => f.get("sampleId"))
          .filter((id) => id);

    const getMax = (arr) => Math.max(0, ...existingIds, ...arr.map((s) => s.id));

    const newSamples = allFeatures.reduce((acc, cur) => {
      const nextId = cur.get("sampleId") || getMax(acc) + 1;
      return [
        ...acc,
        {
          id: nextId,
          visibleId: cur.get("visibleId"),
          sampleGeom: mercator.geometryToGeoJSON(
            cur.getGeometry(),
            "EPSG:4326",
            "EPSG:3857"
          ),
        },
      ];
    }, []);

    setAppState((prev) => ({
      ...prev,
      answerMode: 'answer',
      currentPlot: { ...prev.currentPlot, samples: newSamples },
      userSamples: newSamples.reduce(
        (acc, cur) => ({ ...acc, [cur.id]: prev.userSamples?.[cur.id] || {} }),
        {}
      ),
      userImages: newSamples.reduce(
        (acc, cur) => ({ ...acc, [cur.id]: prev.userImages?.[cur.id] || {} }),
        {}
      ),
    }));
  };

  // enter draw mode on mount
  useEffect(() => {
    return () => setAnswerMode("answer");
  }, [mapConfig]);

  const buttonStyle = (active) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "36px",
    height: "36px",
    marginRight: "10px",
    borderRadius: "6px",
    border: `2px solid ${active ? "#72b879" : "rgba(255, 255, 255, 0.16)"}`,
    background: active ? "rgba(114, 184, 121, 0.22)" : "#0b110d",
    color: active ? "#9ed999" : "#d4d4d8",
  });

  const setDrawTool = (type) => {
    setDrawToolState(type);

    if (answerMode === "draw") {
      mercator.disableDrawing(mapConfig);
      mercator.enableDrawing(mapConfig, "drawLayer", type);
    } else {
      // First time entering draw mode: build the layer from saved samples
      setAnswerMode("draw", type);
    }
  };

  const discardDrawnSamples = () => {
    if (!window.confirm("Discard all samples drawn in this session? Samples from the database will be kept.")) return;

    mercator.disableDrawing(mapConfig);
    mercator.removeLayerById(mapConfig, "drawLayer");

    setAppState((prev) => {
      const dbSamples = (prev.currentPlot?.samples || []).filter((s) => s.visibleId != null);
      const keep = new Set(dbSamples.map((s) => s.id));
      const pick = (obj) =>
            Object.fromEntries(Object.entries(obj || {}).filter(([id]) => keep.has(Number(id))));

      return {
        ...prev,
        answerMode: "answer",
        currentPlot: { ...prev.currentPlot, samples: dbSamples },
        userSamples: pick(prev.userSamples),
        userImages: pick(prev.userImages),
      };
    });
  };

  const RenderDrawTool = ({ icon, title, type }) => (
    <div
      onClick={() => setDrawTool(type)}
      style={{
        alignItems: "center",
        cursor: "pointer",
        display: "flex",
        padding: "8px 0",
      }}
      title={title}
    >
      <span style={buttonStyle(drawTool === type)}>
        <SvgIcon icon={icon} size="2rem" />
      </span>
      {`${type} tool`}
    </div>
  );

  const RenderDrawTools = () => (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {sg.points && (
        <RenderDrawTool
          icon="point"
          title="Click anywhere to add a new point."
          type="Point"
        />
      )}
      {sg.lines && (
        <RenderDrawTool
          icon="lineString"
          title={
            "Click anywhere to start drawing.\n" +
              "A new point along the line string can be added with a single click.\n" +
              "Right click or double click to finish drawing.\n"
          }
          type="LineString"
        />
      )}
      {sg.polygons && (
        <RenderDrawTool
          icon="polygon"
          title={
            "Click anywhere to start drawing.\n" +
              "A new vertex can be added with a single click.\n" +
              "Right click, double click, or complete the polygon to finish drawing.\n"
          }
          type="Polygon"
        />
      )}
      <ul style={{ textAlign: "left", marginTop: "8px" }}>
        How To:
        <li>To modify an existing feature, hold Ctrl and click to drag</li>
        <li>To delete a feature, hold Ctrl and right click on it</li>
        <li>To save changes, click “Save to samples” below</li>
      </ul>
    </div>
  );

  return (
    <SidebarCard
      title="Sample Drawing Tool"
      collapsible
      defaultOpen={true}
      infoText="Draw or edit samples directly on the map"
    >
      <div className="sq-draw-body">
        <RenderDrawTools />
        <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
          <button
            className="btn btn-outline-darkgreen"
            onClick={featuresToSampleLayer}
            disabled={!isDrawing}
            title={
              isDrawing
                ? "Save drawn features back to sample list"
                : "Select a drawing tool to enable"
            }
          >
            Save samples
          </button>
          <button
            className="btn btn-outline-darkgreen"
            onClick={discardDrawnSamples}
            disabled={!isDrawing}
            title={
              isDrawing
                ? "Exit draw mode and return to answering"
                : "Select a drawing tool to enable"
            }
          >
            Discard samples
          </button>
        </div>
      </div>
    </SidebarCard>
  );
};
