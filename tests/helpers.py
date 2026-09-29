from cardgrader.models import CardAssessment, Centering, Defect, SideCentering

ALL = {"front": ["corners", "edges", "surface"], "back": ["corners", "edges", "surface"]}


def card(front=(50, 50), back=(50, 50), defects=(), inspected=ALL, evidence=None) -> CardAssessment:
    """A card assessment. By default every component was inspected, so the grades are complete."""
    extra = {"centering_evidence": evidence} if evidence is not None else {}
    return CardAssessment(
        centering=Centering(front=SideCentering(lr=front[0], tb=front[1]), back=SideCentering(lr=back[0], tb=back[1])),
        defects=[Defect(**d) for d in defects],
        inspected=inspected,
        **extra,
    )


def defect(type_, severity, side="front", location="surface"):
    return {"type": type_, "severity": severity, "side": side, "location": location}
