import React from "react";

import SurveyRulesList from "./SurveyRulesList";
// import NewRuleDesigner from "./NewRuleDesigner";

export default function SurveyRuleDesigner({events, subs}) {
  return (
    <div className="survey-rules-container">
      <div style={{ backgroundColor: '#0c120e', color: '#e4e4e7' }} >
        <SurveyRulesList inDesignMode events={events} subs={subs}/>
        {/* <NewRuleDesigner events={events} subs={subs}/> */}
      </div>
    </div>
  );
}
